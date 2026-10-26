/**
 * Contract between the deploy API (apps/web) and the version-checks consumer (apps/arena).
 *
 * Pure types and constants: no runtime dependencies, so apps/arena can import
 * `@zerosnake/web/shared` without pulling in the site.
 */

/**
 * `CHECKS_QUEUE` message, one per new version.
 *
 * Delivery is at least once: the deploy API re-sends it when a retried deploy finds the version
 * never got enqueued, and Queues may redeliver. The consumer should load the `versions` row and do
 * nothing unless it is still `validating`.
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
