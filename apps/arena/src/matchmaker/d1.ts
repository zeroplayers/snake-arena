/**
 * The matchmaker's reads of D1 (apps/web `src/shared/arena.ts`: D1 is the source of truth for
 * which version of a bot plays).
 */

/** A version as the matchmaker sees it. */
export interface VersionRow {
  versionId: string;
  botId: string;
  /** The bot's owner (user id): a room holds one snake per author. */
  author: string;
  bundleKey: string;
  changeSeq: number;
  /**
   * Its lives may be queued: `ready`, not quarantined, and neither its bot nor the owner archived
   * or banned (a ban already moves the version off `ready`; this doesn't trust that alone).
   */
  playable: boolean;
}

const SELECT = `SELECT v.id AS versionId, v.bot_id AS botId, b.owner_id AS author,
  v.bundle_key AS bundleKey, v.change_seq AS changeSeq,
  (v.status = 'ready' AND v.quarantined_at IS NULL AND b.archived_at IS NULL
    AND b.banned_at IS NULL AND u.banned_at IS NULL) AS playable
  FROM versions v JOIN bots b ON b.id = v.bot_id JOIN users u ON u.id = b.owner_id`;

type RawRow = Omit<VersionRow, "playable"> & { playable: number };

function rows(result: D1Result<RawRow>): VersionRow[] {
  return result.results.map((r) => ({ ...r, playable: Boolean(r.playable) }));
}

/** Versions changed after `cursor` (`versions.change_seq`), in commit order, current state. */
export async function versionChanges(
  db: D1Database,
  cursor: number,
  limit: number,
): Promise<VersionRow[]> {
  return rows(
    await db
      .prepare(`${SELECT} WHERE v.change_seq > ?1 ORDER BY v.change_seq LIMIT ?2`)
      .bind(cursor, limit)
      .all<RawRow>(),
  );
}

/** A page of the playable versions, by bot id after `afterBotId` (the full reconcile). */
export async function playableVersions(
  db: D1Database,
  afterBotId: string,
  limit: number,
): Promise<VersionRow[]> {
  return rows(
    await db
      .prepare(
        `${SELECT} WHERE v.status = 'ready' AND v.bot_id > ?1 AND v.quarantined_at IS NULL
         ORDER BY v.bot_id LIMIT ?2`,
      )
      .bind(afterBotId, limit)
      .all<RawRow>(),
  );
}

/** The given versions' current state (missing ones were deleted). */
export async function versionsById(
  db: D1Database,
  versionIds: string[],
): Promise<Map<string, VersionRow>> {
  if (versionIds.length === 0) return new Map();
  const result = await db
    .prepare(`${SELECT} WHERE v.id IN (SELECT value FROM json_each(?1))`)
    .bind(JSON.stringify(versionIds))
    .all<RawRow>();
  return new Map(rows(result).map((r) => [r.versionId, r]));
}

/** The latest `change_seq` (0 with no versions). */
export async function maxChangeSeq(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT max(change_seq) AS seq FROM versions")
    .first<{ seq: number | null }>();
  return row?.seq ?? 0;
}

/**
 * Lives each bot started since `since` (wall ms), from `lives` rows: what a matchmaker without a
 * ledger (its first start) counts as today's quota already used.
 */
export async function livesStartedSince(
  db: D1Database,
  since: number,
): Promise<{ botId: string; lives: number }[]> {
  const result = await db
    .prepare(
      `SELECT v.bot_id AS botId, count(*) AS lives FROM lives l JOIN versions v ON v.id = l.version_id
       WHERE l.started_at >= ?1 GROUP BY v.bot_id`,
    )
    .bind(since)
    .all<{ botId: string; lives: number }>();
  return result.results;
}
