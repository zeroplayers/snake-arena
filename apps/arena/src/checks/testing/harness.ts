/**
 * Runs the checks consumer (`testing/worker.ts`) in workerd through Miniflare, with D1 migrated
 * from apps/web, the `BUNDLES`/`SOURCES` buckets and the checks queue and its dead-letter queue
 * set up as in `wrangler.jsonc`. Jobs can be delivered by hand (`deliver`, to choose the queue
 * and attempt) or through the real queue (`send`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  CHECK_JOB_VERSION,
  type CheckJob,
  SOURCE_ARCHIVE_FORMAT,
  type SourceArchive,
  type SourceFile,
  type VersionStatus,
} from "@zerosnake/web/shared";
import { build, type Plugin } from "esbuild";
import { Miniflare } from "miniflare";
import { unstable_splitSqlQuery as splitSqlQuery } from "wrangler";
import type { VersionReport } from "../report.ts";

const appDir = join(import.meta.dirname, "../../..");
const migrationsDir = join(appDir, "../web/migrations");

export const QUEUE = "zerosnake-test-checks";
export const DEAD_LETTER_QUEUE = `${QUEUE}-dlq`;
/** As in `wrangler.jsonc`. */
const MAX_RETRIES = 3;

/** Every `.wasm` import is the QuickJS module, provided by Miniflare as a compiled module. */
const wasmPlugin: Plugin = {
  name: "wasm",
  setup(b) {
    b.onResolve({ filter: /\.wasm$/ }, () => ({ path: "./quickjs.wasm", external: true }));
  },
};

export interface VersionState {
  status: VersionStatus;
  report: VersionReport | null;
  activatedAt: number | null;
  updatedAt: number;
}

export interface Deployed {
  job: CheckJob;
  botId: string;
}

export interface Harness {
  /** A user and bot (once per `bot`), the upload in R2 and a `validating` version row. */
  deploy(
    bot: string,
    bundle: string,
    options?: { n?: number; sources?: SourceFile[]; enqueuedAt?: number | null },
  ): Promise<Deployed>;
  /** Hands `job` to the consumer as one batch from `queue`, as delivery number `attempts`. */
  deliver(
    job: unknown,
    options?: { attempts?: number; queue?: string },
  ): Promise<{ acked: boolean; retried: boolean }>;
  /** Sends `job` on `CHECKS_QUEUE`, as the deploy API does. */
  send(job: CheckJob): Promise<void>;
  /** Fires the cron at `time` (Unix ms). */
  cron(time: number): Promise<void>;
  version(id: string): Promise<VersionState | null>;
  /** Waits until the version is no longer `validating` (or throws after `timeoutMs`). */
  settled(id: string, timeoutMs?: number): Promise<VersionState>;
  db: D1Database;
  bundles: R2Bucket;
  sources: R2Bucket;
  /** The bindings apps/web's deploy API uses, on the same D1, buckets and queue. */
  web: {
    DB: D1Database;
    BUNDLES: R2Bucket;
    SOURCES: R2Bucket;
    CHECKS_QUEUE: { send(body: CheckJob): Promise<void> };
  };
  dispose(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const out = await build({
    entryPoints: [join(appDir, "src/checks/testing/worker.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:*"],
    plugins: [wasmPlugin],
    write: false,
  });
  const wasmPath = createRequire(import.meta.url).resolve(
    "@jitl/quickjs-wasmfile-release-sync/wasm",
  );
  const mf = new Miniflare({
    workers: [
      {
        config: {
          name: "arena",
          compatibilityDate: "2026-10-15",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": { type: "esm", contents: out.outputFiles[0]?.text ?? "" },
              "quickjs.wasm": { type: "wasm", contents: new Uint8Array(readFileSync(wasmPath)) },
            },
          },
          env: {
            DB: { type: "d1", id: "test" },
            BUNDLES: { type: "r2", name: "bundles" },
            SOURCES: { type: "r2", name: "sources" },
            CHECKS_QUEUE: { type: "queue", name: QUEUE },
          },
          triggers: [
            {
              type: "queue",
              name: QUEUE,
              maxBatchSize: 1,
              maxBatchTimeout: 0,
              maxRetries: MAX_RETRIES,
              retryDelay: 0,
              deadLetterQueue: DEAD_LETTER_QUEUE,
            },
            { type: "queue", name: DEAD_LETTER_QUEUE, maxBatchSize: 10, maxBatchTimeout: 0 },
          ],
        },
      },
    ],
  } as unknown as ConstructorParameters<typeof Miniflare>[0]);
  await mf.ready;

  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const statements = splitSqlQuery(readFileSync(join(migrationsDir, file), "utf8"));
    await db.batch(statements.map((s) => db.prepare(s)));
  }
  const bundles = (await mf.getR2Bucket("BUNDLES")) as unknown as R2Bucket;
  const sources = (await mf.getR2Bucket("SOURCES")) as unknown as R2Bucket;
  const worker = await mf.getWorker();
  let messages = 0;

  const send = async (job: CheckJob) => {
    const response = await mf.dispatchFetch("http://arena/send", {
      method: "POST",
      body: JSON.stringify(job),
    });
    if (response.status !== 204) throw new Error(`send: ${response.status}`);
  };

  const version = async (id: string): Promise<VersionState | null> => {
    const row = await db
      .prepare(
        `SELECT status, report, activated_at AS activatedAt, updated_at AS updatedAt
         FROM versions WHERE id = ?`,
      )
      .bind(id)
      .first<Omit<VersionState, "report"> & { report: string | null }>();
    return row && { ...row, report: row.report === null ? null : JSON.parse(row.report) };
  };

  return {
    async deploy(bot, bundle, options = {}) {
      const ownerId = `user-${bot}`;
      const botId = `bot-${bot}`;
      const n = options.n ?? 1;
      const files = options.sources ?? [{ path: "src/bot.ts", content: bundle }];
      const archive: SourceArchive = { format: SOURCE_ARCHIVE_FORMAT, files };
      const bundleKey = `${await sha256(bundle)}.js`;
      const archiveText = JSON.stringify(archive);
      const sourceKey = `${await sha256(archiveText)}.json`;
      await bundles.put(bundleKey, bundle);
      await sources.put(sourceKey, archiveText);
      const versionId = `version-${bot}-${n}`;
      const enqueuedAt = options.enqueuedAt === undefined ? Date.now() : options.enqueuedAt;
      await db.batch([
        db
          .prepare("INSERT OR IGNORE INTO users (id, name, email) VALUES (?, ?, ?)")
          .bind(ownerId, bot, `${bot}@example.com`),
        db
          .prepare("INSERT OR IGNORE INTO bots (id, owner_id, name, slug) VALUES (?, ?, ?, ?)")
          .bind(botId, ownerId, bot, bot),
        db
          .prepare(
            `INSERT INTO versions (id, bot_id, n, status, bundle_key, source_key, enqueued_at)
             VALUES (?, ?, ?, 'validating', ?, ?, ?)`,
          )
          .bind(versionId, botId, n, bundleKey, sourceKey, enqueuedAt),
      ]);
      const job: CheckJob = {
        v: CHECK_JOB_VERSION,
        versionId,
        botId,
        ownerId,
        n,
        bundleKey,
        sourceKey,
        enqueuedAt: enqueuedAt ?? Date.now(),
      };
      return { job, botId };
    },

    async deliver(job, { attempts = 1, queue = QUEUE } = {}) {
      const id = `message-${++messages}`;
      const result = await worker.queue(queue, [
        { id, timestamp: new Date(), attempts, body: job },
      ]);
      if (result.outcome !== "ok") throw new Error(`queue handler: ${result.outcome}`);
      return {
        acked: result.ackAll || result.explicitAcks.includes(id),
        retried: result.retryBatch.retry || result.retryMessages.some((m) => m.msgId === id),
      };
    },

    send,

    async cron(time) {
      const result = await worker.scheduled({ scheduledTime: new Date(time) });
      if (result.outcome !== "ok") throw new Error(`scheduled handler: ${result.outcome}`);
    },

    version,

    async settled(id, timeoutMs = 120_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const state = await version(id);
        if (state && state.status !== "validating") return state;
        if (Date.now() > deadline) throw new Error(`version ${id} is still validating`);
        await new Promise((r) => setTimeout(r, 200));
      }
    },

    db,
    bundles,
    sources,
    web: { DB: db, BUNDLES: bundles, SOURCES: sources, CHECKS_QUEUE: { send } },
    dispose: () => mf.dispose(),
  };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(digest).toString("hex");
}

/** Bundles bot source (TS, may import the SDK and the house bots) into one ESM file, like the CLI. */
export async function bundle(source: string): Promise<string> {
  const out = await build({
    stdin: { contents: source, resolveDir: appDir, loader: "ts", sourcefile: "bot.ts" },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    write: false,
  });
  return out.outputFiles[0]?.text ?? "";
}
