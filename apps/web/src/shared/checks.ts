/**
 * Contract between the deploy API (apps/web) and the version-checks consumer (apps/arena).
 *
 * Pure types and constants: no runtime dependencies, so apps/arena can import
 * `@zerosnake/web/shared` without pulling in the site.
 */

/**
 * `CHECKS_QUEUE` message, one per new version, sent once the bundle and sources are in R2.
 *
 * The deploy API sends it once per version (an idempotent retry never re-sends), but delivery is
 * still at least once: Queues may redeliver, and a `send()` that threw may have delivered anyway,
 * after which the API marks that version `rejected` ("couldn't be queued"). So the consumer must
 * load the `versions` row first and skip the job if the row is missing or no longer `validating`,
 * and write its result with `WHERE status = 'validating'`.
 *
 * Making a version `ready` (checks passed):
 * - Set `versions.activated_at` to the time it becomes `ready`. Its rating covers lives started
 *   since then (`src/shared/arena.ts`).
 * - Refuse if the bot is archived (`bots.archived_at` set): an archived bot never has a `ready`
 *   version. Archiving rejects the bot's `validating` versions, so the `status = 'validating'`
 *   guard usually catches it, but check `archived_at` in the same statement too. A trigger
 *   (`versions_ready_unarchived`) aborts any write that would make an archived bot's version
 *   `ready`.
 * - Archive the bot's current `ready` version first, in the same D1 batch (the partial unique
 *   index `versions_bot_ready_idx` allows one per bot). For example, with `?1` the version id,
 *   `?2` the bot id and `?3` now (Unix ms):
 *
 *   ```sql
 *   UPDATE versions SET status = 'archived', updated_at = ?3
 *   WHERE bot_id = ?2 AND status = 'ready'
 *     AND EXISTS (SELECT 1 FROM versions WHERE id = ?1 AND status = 'validating')
 *     AND (SELECT archived_at FROM bots WHERE id = ?2) IS NULL;
 *   UPDATE versions SET status = 'ready', activated_at = ?3, report = ?4, updated_at = ?3
 *   WHERE id = ?1 AND status = 'validating'
 *     AND (SELECT archived_at FROM bots WHERE id = ?2) IS NULL
 *   RETURNING id;
 *   ```
 *
 *   If the second statement returns no row, the version is no longer `validating` or the bot is
 *   archived: the job is done either way. Use `RETURNING`, not `meta.changes`: D1 also counts the
 *   rows triggers change (`versions.change_seq`, migration 0004).
 */
export interface CheckJob {
  /** Message shape version; bumped on incompatible changes. */
  v: typeof CHECK_JOB_VERSION;
  /** `versions.id`. */
  versionId: string;
  /** `bots.id` and the bot's owner (`users.id`). */
  botId: string;
  ownerId: string;
  /** `versions.n`, 1, 2, 3… per bot. */
  n: number;
  /** Key of the single-file ESM bundle in the `BUNDLES` bucket. */
  bundleKey: string;
  /** Key of the `SourceArchive` JSON in the `SOURCES` bucket. */
  sourceKey: string;
  /** Unix ms when the deploy API enqueued it. */
  enqueuedAt: number;
}

export const CHECK_JOB_VERSION = 1;

export function isCheckJob(value: unknown): value is CheckJob {
  if (typeof value !== "object" || value === null) return false;
  const job = value as Record<string, unknown>;
  return (
    job.v === CHECK_JOB_VERSION &&
    typeof job.versionId === "string" &&
    typeof job.botId === "string" &&
    typeof job.ownerId === "string" &&
    typeof job.n === "number" &&
    typeof job.bundleKey === "string" &&
    typeof job.sourceKey === "string" &&
    typeof job.enqueuedAt === "number"
  );
}

/** Result of the deploy checks (`versions.report`), shown by the CLI when a version is rejected. */
export interface CheckReport {
  ok: boolean;
  checks: { name: string; ok: boolean; message?: string }[];
  /** Mean score in the qualification run, if it got that far. */
  qualificationScore?: number;
}

/**
 * What the `SOURCES` bucket holds per version: the bot's source files as UTF-8 text, sorted by
 * path. Paths are relative POSIX paths, already checked by the deploy API (no `..`, no absolute
 * paths, no backslashes).
 */
export interface SourceArchive {
  format: typeof SOURCE_ARCHIVE_FORMAT;
  files: SourceFile[];
}

export interface SourceFile {
  path: string;
  content: string;
}

export const SOURCE_ARCHIVE_FORMAT = "zerosnake-sources@1";

const CHECK_LABELS: Record<string, string> = {
  deploy: "Deploy",
  limits: "Upload limits",
  loads: "Bundle loads",
  seeds: "Fixed seeds",
  qualification: "Qualification",
  "arena-backstop": "Arena",
};

/** A report as plain sentences for people: one per failed check, `Label: message`. */
export function checkReportLines(report: CheckReport | null | undefined): string[] {
  if (!report) return [];
  const lines = report.checks
    .filter((check) => !check.ok)
    .map((check) => `${CHECK_LABELS[check.name] ?? check.name}: ${check.message ?? "failed."}`);
  if (lines.length === 0 && !report.ok) lines.push("The checks failed.");
  // The qualification check's own message usually gives the score already.
  if (report.qualificationScore !== undefined && lines.length === 0) {
    lines.push(`Qualification score: ${report.qualificationScore}.`);
  }
  return lines;
}
