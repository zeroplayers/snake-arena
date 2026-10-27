/**
 * Contract between the site (apps/web) and the matchmaker (apps/arena, `MatchmakerDO`) for which
 * version of a bot plays.
 *
 * **D1 is the source of truth.** A bot plays its `ready` version (at most one per bot, partial
 * unique index `versions_bot_ready_idx`); a bot with none, or an archived one
 * (`bots.archived_at` set, which never has a `ready` version), doesn't play. The site changes
 * that in one D1 transaction when the owner rolls back, archives the active version or archives
 * the bot, and sets `versions.activated_at` on the version it activates.
 *
 * **The RPC is a hint.** After committing, the site calls `activeVersionChanged` on the global
 * matchmaker (`MATCHMAKER.idFromName(MATCHMAKER_NAME)`), best effort: it isn't retried, and a
 * failure doesn't undo the change. So the matchmaker must also reconcile from D1 on its own
 * (on start-up and periodically): queue lives only for `ready` versions, drop queued lives of
 * versions that aren't `ready` any more, and before a room starts a life check that its
 * version is still `ready`.
 *
 * A cheap incremental poll uses `versions.change_seq`, which triggers set to one more than the
 * largest so far whenever a version is inserted or its `status` changes. D1 runs one write
 * transaction at a time, so it grows in commit order and a cursor never skips a change (unlike
 * `updated_at`, the writer's clock before commit):
 *
 * ```sql
 * SELECT id, bot_id, status, change_seq FROM versions
 * WHERE change_seq > ?1 ORDER BY change_seq LIMIT 500
 * ```
 *
 * then continue from the last row's `change_seq` (start from 0). A row shows up once per change
 * with its current status. Deleted versions (an account deleted) don't show up, so the full
 * reconcile still matters.
 *
 * On `activeVersionChanged`, the matchmaker should replace the bot's queued lives with lives of
 * `versionId` (none if `null`), and let lives already running in rooms finish (or retire them;
 * the arena's call). Versions the checks consumer makes `ready` are the arena's own change and
 * don't go through this.
 *
 * Ratings: a version activated by a rollback starts its rating over (the site deletes its
 * `ratings` row and moves `versions.activated_at`). Rating writers count only lives started at or
 * after `versions.activated_at`, including when they rebuild a rating from `lives`, and write the
 * `activated_at` they counted from into `ratings.activated_at`. A trigger
 * (`ratings_stint_insert`/`ratings_stint_update`) ignores a write whose `activated_at` isn't the
 * version's current one, so a writer that read the version before a rollback can't bring the old
 * rating back. Upsert with `RETURNING`; no row back means the stint ended, so drop the result:
 *
 * ```sql
 * INSERT INTO ratings (version_id, activated_at, mean, ci, n_lives, updated_at)
 * VALUES (?1, ?2, ?3, ?4, ?5, ?6)
 * ON CONFLICT (version_id) DO UPDATE SET activated_at = excluded.activated_at,
 *   mean = excluded.mean, ci = excluded.ci, n_lives = excluded.n_lives,
 *   updated_at = excluded.updated_at
 * RETURNING version_id
 * ```
 */

/** `idFromName` of the single global `MatchmakerDO`. */
export const MATCHMAKER_NAME = "global";

export const ACTIVE_VERSION_CHANGE_VERSION = 1;

export type ActiveVersionChangeReason =
  /** The owner made an earlier version active again (a rollback). */
  | "activate"
  /** The owner archived the active version; the bot has none now. */
  | "deactivate"
  /** The owner archived the bot (and with it its active version). */
  | "archive_bot";

export interface ActiveVersionChange {
  v: typeof ACTIVE_VERSION_CHANGE_VERSION;
  botId: string;
  ownerId: string;
  reason: ActiveVersionChangeReason;
  /** The bot's `ready` version now; `null` if it has none (it stops playing). */
  versionId: string | null;
  /** The version that was `ready` before, if any. Its lives should stop being queued. */
  previousVersionId: string | null;
  /** Unix ms of the D1 commit. */
  changedAt: number;
}

/** RPC methods the site calls on the `MatchmakerDO` stub (besides the arena's own room → matchmaker RPC). */
export interface MatchmakerSiteRpc {
  activeVersionChanged(change: ActiveVersionChange): Promise<void>;
}

/** Arena quotas the site shows (SPEC §4). The matchmaker enforces them. */
export const ARENA_LIMITS = {
  /** Lives a bot (all its versions) starts per UTC day. */
  livesPerBotPerDay: 100,
} as const;
