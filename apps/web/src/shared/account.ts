/**
 * Account deletion ("Delete my account" on `/settings`, `src/server/account.ts`), as plain SQL
 * so apps/arena's tests run exactly what the site runs.
 *
 * It happens in two steps:
 *
 * 1. **At once**, one D1 batch (`DELETE_ACCOUNT_STATEMENTS`): the user row is kept as a
 *    tombstone (`users.deleted_at`) with every personal field scrubbed, the GitHub link (and its
 *    OAuth tokens), CLI tokens and device codes are deleted, every web session is revoked
 *    (`users.sessions_revoked_at`), and the bots are archived: `ready` versions become
 *    `archived`, versions still in checks `rejected`. That bumps `versions.change_seq`, so the
 *    matchmaker's poll stops the bots within seconds and retires their running lives, as for
 *    any archive (`src/shared/arena.ts`). The profile, bot pages and leaderboard rows are gone
 *    from then on (no username, no `ready` version).
 * 2. **Later**, the site's 5-minute cron (`purgeDeletedAccounts`) erases what is left, once
 *    `ACCOUNT_PURGE_AFTER_MS` has passed so that rooms have written the retired lives: lives
 *    (and their traces in R2), then versions (bundles and sources in R2; ratings, activations and
 *    version kills go with them), then the user row, which takes the bots with it.
 *
 * Rows that stay: other players' lives keep `killer` = the deleted version's id, which then
 * resolves to nothing ("a deleted bot"); `moderation_actions` keeps its plain ids (abuse
 * prevention); replay chunks in R2 name snakes by life and user id only, and expire with the
 * replay retention. Metrics and logs carry the same opaque ids and age out on their own.
 *
 * A room that writes a life of a version deleted meanwhile drops it (apps/arena `db.ts`,
 * `insertLives`), rather than retrying a foreign key failure forever.
 */

/** How long after step 1 the purge may start: lives retired by the matchmaker are written by then. */
export const ACCOUNT_PURGE_AFTER_MS = 15 * 60_000;

/** What the scrubbed user row is called; its email becomes `deleted-<id>@deleted.invalid`. */
export const DELETED_USER_NAME = "Deleted user";

/**
 * Step 1, in order, as one D1 batch (a transaction). `?1` is the user id, `?2` the time (Unix
 * ms). Idempotent. The second statement returns the versions it took off `ready` (`id`,
 * `bot_id`), for the matchmaker hint.
 */
export const DELETE_ACCOUNT_STATEMENTS = [
  `UPDATE users SET deleted_at = coalesce(deleted_at, ?2), sessions_revoked_at = ?2,
     name = '${DELETED_USER_NAME}', email = 'deleted-' || id || '@deleted.invalid',
     email_verified = 0, image = NULL, username = NULL, display_username = NULL,
     github_login = NULL, updated_at = ?2
   WHERE id = ?1`,
  `UPDATE versions SET status = 'archived', updated_at = ?2
   WHERE status = 'ready' AND bot_id IN (SELECT id FROM bots WHERE owner_id = ?1)
   RETURNING id, bot_id`,
  // The checks consumer skips versions that aren't `validating` any more.
  `UPDATE versions SET status = 'rejected', updated_at = ?2
   WHERE status = 'validating' AND bot_id IN (SELECT id FROM bots WHERE owner_id = ?1)`,
  "UPDATE bots SET archived_at = ?2 WHERE owner_id = ?1 AND archived_at IS NULL",
  "DELETE FROM accounts WHERE user_id = ?1",
  "DELETE FROM cli_tokens WHERE user_id = ?1",
  "DELETE FROM device_codes WHERE user_id = ?1",
] as const;

/** What to bind to one of `DELETE_ACCOUNT_STATEMENTS`: D1 wants exactly the parameters it uses. */
export function deleteAccountParams(statement: string, userId: string, at: number) {
  return statement.includes("?2") ? [userId, at] : [userId];
}

/** Index in `DELETE_ACCOUNT_STATEMENTS` of the statement returning the stopped versions. */
export const DELETE_ACCOUNT_STOPPED = 1;

/** `?1` = user id: its versions (`IN (...)`), for the purge's statements. */
const OWN_VERSIONS =
  "SELECT v.id FROM versions v JOIN bots b ON b.id = v.bot_id WHERE b.owner_id = ?1";

/**
 * Step 2's statements. Each `select*` returns a page (`?2` = page size) and the matching
 * `delete*` deletes the rows named in `?1` (a JSON array of ids) once their R2 objects are gone.
 */
export const PURGE_SQL = {
  /** Tombstones due for the purge: `?1` = latest `deleted_at` (Unix ms), `?2` = how many. */
  dueUsers: `SELECT id FROM users WHERE deleted_at IS NOT NULL AND deleted_at <= ?1
             ORDER BY deleted_at LIMIT ?2`,
  selectLives: `SELECT id, trace_key AS traceKey FROM lives WHERE version_id IN (${OWN_VERSIONS})
                LIMIT ?2`,
  deleteLives: "DELETE FROM lives WHERE id IN (SELECT value FROM json_each(?1))",
  selectVersions: `SELECT v.id, v.bundle_key AS bundleKey, v.source_key AS sourceKey
                   FROM versions v JOIN bots b ON b.id = v.bot_id WHERE b.owner_id = ?1 LIMIT ?2`,
  deleteVersions: "DELETE FROM versions WHERE id IN (SELECT value FROM json_each(?1))",
  /** Last: the tombstone, and with it bots and whatever else still points at the user. */
  deleteUser: "DELETE FROM users WHERE id = ?1 AND deleted_at IS NOT NULL",
} as const;
