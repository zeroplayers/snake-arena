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
 * largest so far whenever a version is inserted or its `status` or `quarantined_at` changes. D1
 * runs one write transaction at a time, so it grows in commit order and a cursor never skips a
 * change (unlike `updated_at`, the writer's clock before commit):
 *
 * ```sql
 * SELECT id, bot_id, status, quarantined_at, change_seq FROM versions
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
 * `ratings` row and moves `versions.activated_at`). Ratings count only lives started at or after
 * `versions.activated_at`, and not those ended with `death_cause = 'retired'`. The site's rating
 * job (`src/server/ratings.ts`) computes them from `lives`, so the arena only inserts `lives` rows
 * (`INSERT ... ON CONFLICT (id) DO NOTHING`, never `INSERT OR REPLACE`) and writes no `ratings`.
 * It writes the `activated_at` it counted from into `ratings.activated_at`; a trigger
 * (`ratings_stint_insert`/`ratings_stint_update`) ignores a write whose `activated_at` isn't the
 * version's current one, so a rating computed before a rollback can't bring the old one back.
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
  | "archive_bot"
  /**
   * An admin banned the version, the bot or its author (see "Moderation" below). End the
   * running lives of `previousVersionId` now rather than letting them finish.
   */
  | "moderation";

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
  /** The kill switch changed (see "Kill switch" below). Best effort, like the other. */
  arenaControlChanged(control: ArenaControl): Promise<void>;
}

// ─── Kill switch ─────────────────────────────────────────────────────────────────────────────────

/**
 * The kill switch admins flip on `/admin`: one D1 row, `arena_control` with `id = 1` (made by
 * migration 0005; treat a missing row as all zeros, "running"). Read it with
 *
 * ```sql
 * SELECT paused, deploys_paused, reason, deploys_reason, updated_at FROM arena_control WHERE id = 1
 * ```
 *
 * `paused = 1` stops the arena. Then the matchmaker:
 * - starts no lives (`nextLife` returns `null`) and starts no rooms;
 * - ends the lives running in rooms (`RoomRpc.leave`), so rooms flush their replays and close.
 *   The lives end with `death_cause = 'retired'` (nobody's fault), rated however the arena
 *   rates retired lives elsewhere.
 *
 * The site calls `arenaControlChanged` after each change (best effort), so the matchmaker can
 * act at once; it must also poll the row, at least every `ARENA_CONTROL_POLL_MS`, and before
 * starting a room. As a backstop against a matchmaker that's itself the problem, a room
 * re-reads the row at the same interval (one primary-key read, cached in memory in between)
 * and, when paused, retires its lives and closes by itself.
 *
 * `paused = 0` again: carry on as after a restart (reconcile from D1, refill rooms).
 *
 * `deploys_paused = 1` makes the deploy API refuse new versions (503 `deploys_paused`). The
 * checks consumer should go on with versions already queued; to stop bot code from running at
 * all, pause both.
 */
export interface ArenaControl {
  v: typeof ARENA_CONTROL_VERSION;
  paused: boolean;
  deploysPaused: boolean;
  /** Why `paused` last changed, as the admin wrote it. */
  reason: string | null;
  /** Why `deploysPaused` last changed (its own column, `deploys_reason`, migration 0006). */
  deploysReason: string | null;
  /** Unix ms of the change. */
  updatedAt: number;
}

export const ARENA_CONTROL_VERSION = 1;

/** How stale the matchmaker's and rooms' view of `arena_control` may get. */
export const ARENA_CONTROL_POLL_MS = 30_000;

// ─── Moderation ──────────────────────────────────────────────────────────────────────────────────

/**
 * Admins (`ADMIN_USER_IDS` / `ADMIN_GITHUB_IDS`, see `src/server/moderation.ts`) can ban a
 * version, a bot or a user. Every ban is plain D1 state the matchmaker already follows, so
 * nothing new has to be read:
 *
 * - **Version**: `status = 'rejected'`, with a failed check `{ name: "moderation", ok: false,
 *   message: <reason> }` appended to `versions.report`, and `report.text`, if any, prefixed
 *   with "Rejected by a moderator: <reason>" so the suite's "Checks passed" isn't the first
 *   thing the author reads. Final.
 * - **Bot**: `bots.banned_at` / `ban_reason` set; its `ready` version becomes `archived` and
 *   versions still in checks become `rejected` (same as archiving the bot). Lifting the ban
 *   leaves the bot with no active version, the owner picks one.
 * - **User**: `users.banned_at` / `ban_reason` set; the same happens to each of their bots
 *   (but `bots.banned_at` stays as it was). They can't deploy or sign in the CLI.
 *
 * Each status change bumps `versions.change_seq`, so the incremental poll sees it, and the site
 * sends `activeVersionChanged` with reason `moderation` for each bot whose `ready` version went
 * away. A trigger (`versions_ready_unbanned`) aborts any write that would make a version of a
 * banned bot, or of a banned user's bot, `ready`: the checks consumer must reject the version
 * (`reason: banned`) rather than retry; see `CheckJob` in `src/shared/checks.ts`.
 *
 * The checks consumer, before running a job, may skip it (and leave the version `rejected`)
 * if the bot or its owner is banned; the ban already rejected `validating` versions, so this
 * only matters for a job it picked up mid-ban.
 */
export const MODERATION_CHECK_NAME = "moderation";

// ─── Quarantine ──────────────────────────────────────────────────────────────────────────────────

/**
 * A room's CPU backstop (apps/arena `room.ts`) **evicts** a life whose calls the room's CPU limit
 * keeps cutting short, so the room makes progress: the life ends with the neutral cause `evicted`
 * (no `lives` row, not rated; the matchmaker still gets `lifeEnded`). A version evicted
 * `EVICTIONS_TO_QUARANTINE` (2) times in one room is **quarantined**, for everyone:
 *
 * ```sql
 * UPDATE versions SET quarantined_at = ?2, quarantine_reason = ?3
 * WHERE id = ?1 AND quarantined_at IS NULL RETURNING id
 * ```
 *
 * So is a version whose calls the backstop named `VERSION_KILLS_TO_QUARANTINE` (6) times within a
 * week, across lives and rooms: rooms write each named kill to `version_kills` (and mark it
 * `retracted` when a later kill in that room named nobody, which only a restart does), and the
 * same batch quarantines the version once it has that many unretracted rows. That catches a bot
 * that burns too rarely for any one life of it to be evicted.
 *
 * It isn't a ban: `status` stays `ready` and the owner can deploy or roll back as usual (a new
 * version starts unquarantined). It bumps `change_seq`, so the incremental poll sees it. The
 * matchmaker must queue no lives of a version with `quarantined_at` set, and drop the ones it
 * queued; rooms also refuse them (`join` → `quarantined`, read from D1). Lives of it already
 * running in other rooms play on, and may get it evicted there too. An admin lifts it by setting
 * `quarantined_at` back to `NULL` (no UI yet). The site shows it on the bot page and the CLI in
 * `zerosnake status` / `logs`.
 *
 * TODO(#23): the matchmaker should also count `evicted` lives per version across rooms and
 * quarantine at the same threshold; rooms only count their own.
 */
export interface VersionQuarantine {
  /** ISO 8601. */
  at: string;
  reason: string;
}

/** Arena quotas the site shows (SPEC §4). The matchmaker enforces them. */
export const ARENA_LIMITS = {
  /** Lives a bot (all its versions) starts per UTC day. */
  livesPerBotPerDay: 100,
} as const;
