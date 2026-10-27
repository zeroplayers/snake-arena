/**
 * Version-checks Queue consumer (SPEC §6, #22). The deploy API (apps/web) inserts a `validating`
 * version, stores its bundle and sources in R2 and sends a `CheckJob`; this runs
 * `@zerosnake/checks` on it and makes the version `ready` or `rejected`. Contract:
 * `apps/web/src/shared/checks.ts`.
 *
 * - **At least once.** A job whose version is missing or no longer `validating` is acked
 *   without doing anything, and every write is guarded by `status = 'validating'`, so a
 *   redelivery (or two deliveries racing) can't change a finished version.
 * - **One job at a time per isolate.** A run holds a sandbox with up to 64 MiB of wasm heap
 *   against the isolate's 128 MB; `max_batch_size: 1` and {@link serially} keep it to one.
 * - **CPU limit.** workerd's clock stands still while the suite computes, so the only bound on
 *   a slow bot there is the Worker's CPU limit, which kills the invocation without a chance to
 *   write anything. The message is then redelivered, and after `max_retries` it goes to the
 *   dead-letter queue, whose consumer (also this handler) rejects the version with
 *   `checks_failed_to_complete`. Errors on our side (R2, D1) take the same path after retries.
 * - **Inputs that can't succeed** are rejected at once, not retried: an upload missing from R2
 *   (`input_missing`), a source archive that isn't one (`input_malformed`), or an object over
 *   the upload limits, which isn't even read (`input_too_large`, a `limits` check).
 * - **Reaper.** {@link reapStaleVersions} (cron) rejects versions queued long ago that are still
 *   `validating`, in case a job was lost altogether, and versions whose deploy request died
 *   before queueing a job (`enqueue_failed`).
 */
import { LIMITS, runChecks, type SourceFile as SizedSource } from "@zerosnake/checks";
import {
  type CheckJob,
  isCheckJob,
  SOURCE_ARCHIVE_FORMAT,
  type SourceArchive,
  type SourceFile,
} from "@zerosnake/web/shared";
// Wrangler only treats specifiers ending in .wasm as compiled modules; the package's "./wasm"
// export doesn't, so import the file itself.
import wasmModule from "../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm";
import {
  failureReport,
  tooLargeReport,
  type VersionReport,
  versionReport,
} from "./checks/report.ts";
import {
  loadVersion,
  markPassed,
  markRejected,
  type Outcome,
  rejectStale,
  rejectUnqueued,
  STALE_AFTER_MS,
  UNQUEUED_AFTER_MS,
} from "./checks/versions.ts";

export type { CheckJob };

export type ChecksEnv = Pick<Env, "DB" | "BUNDLES" | "SOURCES">;

/** Dead-letter queues are named after their queue: `zerosnake-<env>-checks-dlq`. */
const DEAD_LETTER_SUFFIX = "-dlq";

/**
 * Largest source archive read: JSON escapes a byte as at most 6 (`\u0000`), plus room for paths
 * and framing, so an archive within `LIMITS.maxSourceBytes` is never refused here. Anything
 * bigger is over the limit for sure.
 */
const MAX_ARCHIVE_BYTES = 8 * LIMITS.maxSourceBytes;

export async function handleChecks(batch: MessageBatch<unknown>, env: ChecksEnv): Promise<void> {
  const deadLetters = batch.queue.endsWith(DEAD_LETTER_SUFFIX);
  for (const message of batch.messages) {
    if (deadLetters) await giveUp(message, env);
    else await serially(() => check(message, env));
  }
}

/** Runs one job from the checks queue; acks it once the version is done, retries on errors. */
async function check(message: Message<unknown>, env: ChecksEnv): Promise<void> {
  const job = message.body;
  if (!isCheckJob(job)) {
    console.error("checks: dropping a malformed job", message.id, JSON.stringify(job));
    message.ack();
    return;
  }
  try {
    const outcome = await checkVersion(job, env);
    console.log("checks:", job.versionId, outcome, `attempt ${message.attempts}`);
    message.ack();
  } catch (error) {
    // R2 or D1 failed: try again after the queue's `retry_delay`.
    // After the last retry the job goes to the dead-letter queue, and `giveUp` rejects it.
    console.error("checks: job failed", job.versionId, `attempt ${message.attempts}`, error);
    message.retry();
  }
}

export type CheckOutcome = Outcome | "missing";

/** Checks one version and writes the result; throws only on errors worth retrying. */
export async function checkVersion(job: CheckJob, env: ChecksEnv): Promise<CheckOutcome> {
  const version = await loadVersion(env.DB, job.versionId);
  if (!version) return "missing";
  // Not `enqueued_at`: the deploy API sets it after `send()`, so a job can arrive before it.
  if (version.status !== "validating") return "unchanged";
  if (version.botArchivedAt !== null) {
    return markRejected(env.DB, version.id, failureReport("bot_archived"), Date.now());
  }

  // Inputs that no retry can fix: reject now, with what is wrong.
  const reject = (report: VersionReport) => markRejected(env.DB, version.id, report, Date.now());

  // The row's keys, not the job's: D1 is the source of truth.
  const [bundle, archive] = await Promise.all([
    env.BUNDLES.get(version.bundleKey),
    env.SOURCES.get(version.sourceKey),
  ]);
  if (!bundle || !archive) {
    const missing = [
      !bundle && `bundle ${version.bundleKey}`,
      !archive && `sources ${version.sourceKey}`,
    ];
    console.error("checks: not in R2:", version.id, missing.filter(Boolean).join(", "));
    return reject(failureReport("input_missing"));
  }
  // The deploy API enforces the limits, so these only guard the isolate's memory.
  if (bundle.size > LIMITS.maxBundleBytes) {
    return reject(tooLargeReport("bundle", bundle.size, LIMITS.maxBundleBytes));
  }
  if (archive.size > MAX_ARCHIVE_BYTES) {
    return reject(
      tooLargeReport("the source archive", archive.size, LIMITS.maxSourceBytes, "source"),
    );
  }
  // Reading may fail on our side (retried); what was read is either an archive or never will be.
  const [bundleText, archiveText] = await Promise.all([bundle.text(), archive.text()]);
  const sources = sourceSizes(archiveText);
  if (!sources) {
    console.error("checks: malformed source archive", version.id, version.sourceKey);
    return reject(failureReport("input_malformed"));
  }

  const suite = await runChecks({ bundle: bundleText, sources }, { wasmModule });
  const report = versionReport(suite);
  const now = Date.now();
  return suite.passed
    ? markPassed(env.DB, version, report, failureReport("bot_archived"), now)
    : markRejected(env.DB, version.id, report, now);
}

/**
 * The suite only counts the sources: their paths and UTF-8 sizes. `null` if `text` isn't a
 * `zerosnake-sources@1` archive.
 */
function sourceSizes(text: string): SizedSource[] | null {
  let a: Partial<SourceArchive> | null;
  try {
    a = JSON.parse(text);
  } catch {
    return null;
  }
  if (a?.format !== SOURCE_ARCHIVE_FORMAT || !Array.isArray(a.files)) return null;
  const files: unknown[] = a.files;
  const valid = files.every(
    (f) =>
      typeof f === "object" &&
      f !== null &&
      typeof (f as SourceFile).path === "string" &&
      typeof (f as SourceFile).content === "string",
  );
  if (!valid) return null;
  const encoder = new TextEncoder();
  return a.files.map((f) => ({ path: f.path, bytes: encoder.encode(f.content).byteLength }));
}

/** A job that ran out of retries: its version, if still `validating`, is rejected. */
async function giveUp(message: Message<unknown>, env: ChecksEnv): Promise<void> {
  const job = message.body;
  if (!isCheckJob(job)) {
    console.error("checks: dropping a malformed dead letter", message.id, JSON.stringify(job));
    message.ack();
    return;
  }
  try {
    const report = failureReport("checks_failed_to_complete");
    const outcome = await markRejected(env.DB, job.versionId, report, Date.now());
    console.warn("checks: gave up on", job.versionId, outcome);
    message.ack();
  } catch (error) {
    console.error("checks: dead letter failed", job.versionId, error);
    message.retry();
  }
}

/**
 * Cron: rejects versions that have been `validating` for {@link STALE_AFTER_MS} since queueing,
 * and those never queued {@link UNQUEUED_AFTER_MS} after being created.
 */
export async function reapStaleVersions(env: Pick<Env, "DB">, now = Date.now()): Promise<string[]> {
  const [stale, unqueued] = await Promise.all([
    rejectStale(env.DB, now - STALE_AFTER_MS, failureReport("checks_failed_to_complete"), now),
    rejectUnqueued(env.DB, now - UNQUEUED_AFTER_MS, failureReport("enqueue_failed"), now),
  ]);
  if (stale.length) console.warn("checks: rejected stale versions", stale);
  if (unqueued.length) console.warn("checks: rejected versions never queued", unqueued);
  return [...stale, ...unqueued];
}

let running: Promise<unknown> = Promise.resolve();

/**
 * Runs `task` after every task started before it in this isolate has settled. Queues may run
 * several consumer invocations in one isolate; only one may hold a sandbox at a time.
 */
function serially<T>(task: () => Promise<T>): Promise<T> {
  const result = running.then(task, task);
  running = result.catch(() => {});
  return result;
}
