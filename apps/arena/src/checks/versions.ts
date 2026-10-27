/**
 * The checks consumer's D1 reads and writes on `versions`, following the contract in
 * `apps/web/src/shared/checks.ts`: every write is guarded by `status = 'validating'`, so a
 * redelivered or duplicate job can't change a version that is already done, and results are
 * read from `RETURNING` (D1's `meta.changes` also counts the rows triggers touch).
 */
import type { VersionReport } from "./report.ts";

export interface VersionRow {
  id: string;
  botId: string;
  n: number;
  status: string;
  bundleKey: string;
  sourceKey: string;
  /** The bot's `archived_at`, Unix ms. */
  botArchivedAt: number | null;
}

export async function loadVersion(db: D1Database, id: string): Promise<VersionRow | null> {
  return db
    .prepare(
      `SELECT v.id, v.bot_id AS botId, v.n, v.status, v.bundle_key AS bundleKey,
         v.source_key AS sourceKey, b.archived_at AS botArchivedAt
       FROM versions AS v JOIN bots AS b ON b.id = v.bot_id
       WHERE v.id = ?1`,
    )
    .bind(id)
    .first<VersionRow>();
}

/**
 * What a write did:
 * - `ready`: the version is the bot's active one now (the previous one is `archived`);
 * - `superseded`: it passed, but a later version of the bot became `ready` first, so it is
 *   `archived` (the owner can still activate it on the site);
 * - `rejected`;
 * - `unchanged`: it wasn't `validating` any more (another delivery or the site got there first).
 */
export type Outcome = "ready" | "superseded" | "rejected" | "unchanged";

const BOT_UNARCHIVED = "(SELECT archived_at FROM bots WHERE id = ?2) IS NULL";

/**
 * Ends a version whose checks passed, in one D1 batch (a transaction):
 * 1. archive the bot's current `ready` version, if it is older than this one (one `ready` per
 *    bot: `versions_bot_ready_idx`);
 * 2. make this one `ready` with `activated_at` = now, unless the bot is archived or a newer
 *    version is still `ready`;
 * 3. otherwise, if the bot is not archived: keep it as `archived` (it passed, just too late);
 * 4. otherwise, the bot is archived: `rejected`, as archiving a bot rejects its `validating`
 *    versions (`versions_ready_unarchived` would abort step 2 anyway).
 */
export async function markPassed(
  db: D1Database,
  version: Pick<VersionRow, "id" | "botId">,
  report: VersionReport,
  archivedBotReport: VersionReport,
  now: number,
): Promise<Outcome> {
  const json = JSON.stringify(report);
  const results = await db.batch<{ id: string }>([
    db
      .prepare(
        `UPDATE versions SET status = 'archived', updated_at = ?3
         WHERE bot_id = ?2 AND status = 'ready'
           AND n < (SELECT n FROM versions WHERE id = ?1)
           AND EXISTS (SELECT 1 FROM versions WHERE id = ?1 AND status = 'validating')
           AND ${BOT_UNARCHIVED}`,
      )
      .bind(version.id, version.botId, now),
    db
      .prepare(
        `UPDATE versions SET status = 'ready', activated_at = ?3, report = ?4, updated_at = ?3
         WHERE id = ?1 AND status = 'validating' AND ${BOT_UNARCHIVED}
           AND NOT EXISTS (SELECT 1 FROM versions WHERE bot_id = ?2 AND status = 'ready')
         RETURNING id`,
      )
      .bind(version.id, version.botId, now, json),
    db
      .prepare(
        `UPDATE versions SET status = 'archived', report = ?4, updated_at = ?3
         WHERE id = ?1 AND status = 'validating' AND ${BOT_UNARCHIVED}
         RETURNING id`,
      )
      .bind(version.id, version.botId, now, json),
    db
      .prepare(
        `UPDATE versions SET status = 'rejected', report = ?4, updated_at = ?3
         WHERE id = ?1 AND status = 'validating' AND NOT ${BOT_UNARCHIVED}
         RETURNING id`,
      )
      .bind(version.id, version.botId, now, JSON.stringify(archivedBotReport)),
  ]);
  if (results[1]?.results.length) return "ready";
  if (results[2]?.results.length) return "superseded";
  if (results[3]?.results.length) return "rejected";
  return "unchanged";
}

/** Rejects a version that is still `validating`. */
export async function markRejected(
  db: D1Database,
  id: string,
  report: VersionReport,
  now: number,
): Promise<Outcome> {
  const row = await db
    .prepare(
      `UPDATE versions SET status = 'rejected', report = ?2, updated_at = ?3
       WHERE id = ?1 AND status = 'validating'
       RETURNING id`,
    )
    .bind(id, JSON.stringify(report), now)
    .first();
  return row ? "rejected" : "unchanged";
}

/** Versions still `validating` this long after being queued are rejected by the reaper. */
export const STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * Rejects every version queued before `queuedBefore` (Unix ms) that is still `validating`: its
 * job was lost, or is stuck far longer than retries and the dead-letter queue take. Versions
 * not queued yet (`enqueued_at` null) belong to the deploy API, which ends them itself.
 */
export async function rejectStale(
  db: D1Database,
  queuedBefore: number,
  report: VersionReport,
  now: number,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `UPDATE versions SET status = 'rejected', report = ?2, updated_at = ?3
       WHERE status = 'validating' AND enqueued_at IS NOT NULL AND enqueued_at < ?1
       RETURNING id`,
    )
    .bind(queuedBefore, JSON.stringify(report), now)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}
