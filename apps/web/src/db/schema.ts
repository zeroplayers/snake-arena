/**
 * D1 schema shared by apps/web and apps/arena. Edit this file, then `pnpm db:generate` writes the
 * next SQL migration into `migrations/` (applied by `wrangler d1 migrations apply DB`).
 *
 * The first block is Better Auth's tables (plural model names, `usePlural: true`); the field keys
 * must match what Better Auth expects, `src/db/schema.test.ts` checks that. The second block is the
 * arena: bots, their versions, the lives each version played and the rating derived from them.
 */
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { CheckReport } from "../shared/checks";
import { type DeployMeta, type VersionStatus, versionStatuses } from "../shared/deploy";

const now = sql`(cast(unixepoch('subsecond') * 1000 as integer))`;

/** `CHECK (column IN (...))`, since D1 has no enum type and apps/arena writes these rows too. */
const oneOf = (column: AnySQLiteColumn, values: readonly string[]) =>
  sql`${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const createdAt = () => integer("created_at", { mode: "timestamp_ms" }).notNull().default(now);

const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(now)
    .$onUpdate(() => new Date());

// ─── Better Auth ────────────────────────────────────────────────────────────────────────────────

export const users = sqliteTable("users", {
  id: id(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  /** Claimed once after the first sign-in (`/username/claim`), lowercase. `null` until then. */
  username: text("username").unique(),
  displayUsername: text("display_username"),
  /** GitHub login at sign-in, used to suggest a username. */
  githubLogin: text("github_login"),
  /**
   * Set by an admin (`src/server/moderation.ts`); `null` while in good standing. A banned user
   * can sign in and look, but can't deploy, create or change bots, or sign in the CLI, and none
   * of their bots play (their `ready` versions were archived by the ban).
   */
  bannedAt: integer("banned_at", { mode: "timestamp_ms" }),
  banReason: text("ban_reason"),
  /** Web sessions created up to this moment are revoked (`/revoke-sessions`, "sign out everywhere"). */
  sessionsRevokedAt: integer("sessions_revoked_at", { mode: "timestamp_ms" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Unused: web sessions live in KV, bound to apps/web only (src/server/session-store.ts, #50).
 * Emptied by migration 0011 and kept one release so the site still running during a deploy
 * doesn't fail on it; dropped in a follow-up (#81).
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: id(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

/**
 * Signed-out web sessions, by SHA-256 of the token (useless to whoever reads this database), until
 * they would have expired. Sessions are in KV, which can serve a deleted one for a while longer;
 * this is what makes a sign-out final (src/server/session-store.ts). Pruned by the 5-minute cron.
 */
export const revokedSessions = sqliteTable(
  "revoked_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("revoked_sessions_expires_at_idx").on(t.expiresAt)],
);

export const accounts = sqliteTable(
  "accounts",
  {
    id: id(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("accounts_user_id_idx").on(t.userId),
    uniqueIndex("accounts_provider_account_idx").on(t.providerId, t.accountId),
  ],
);

export const verifications = sqliteTable(
  "verifications",
  {
    id: id(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

/** Device authorization grant (RFC 8628) behind `zerosnake login`. */
export const deviceCodes = sqliteTable("device_codes", {
  id: id(),
  deviceCode: text("device_code").notNull().unique(),
  userCode: text("user_code").notNull().unique(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  /** `pending`, `approved` or `denied`. */
  status: text("status").notNull(),
  lastPolledAt: integer("last_polled_at", { mode: "timestamp_ms" }),
  pollingInterval: integer("polling_interval"),
  clientId: text("client_id"),
  scope: text("scope"),
});

/**
 * Tokens `zerosnake login` gets from the device flow. Not Better Auth sessions: they can't call
 * any auth endpoint, and only a SHA-256 of the token is stored, since this database is also bound
 * to apps/arena. See `src/server/cli-auth.ts`.
 */
export const cliTokens = sqliteTable(
  "cli_tokens",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Hex SHA-256 of the bearer token. */
    tokenHash: text("token_hash").notNull().unique(),
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
    createdAt: createdAt(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }).notNull().default(now),
    /** Slides forward when the token is used. */
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("cli_tokens_user_id_idx").on(t.userId)],
);

// ─── Arena ──────────────────────────────────────────────────────────────────────────────────────

export const bots = sqliteTable(
  "bots",
  {
    id: id(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * URL segment, unique per owner: `/@{username}/{slug}`, and the CLI's handle for the bot.
     * Never changes: a rename only changes `name`, so links and `zerosnake deploy` keep working.
     * An archived bot keeps its slug.
     */
    slug: text("slug").notNull(),
    /** Skin id; `null` means the default skin. */
    skin: text("skin"),
    /**
     * Set when the owner archives the bot (`null` while active). An archived bot has no `ready`
     * version, doesn't count against `botsPerAuthor` and can't be deployed to until restored.
     */
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    /**
     * Set by an admin (`src/server/moderation.ts`). Like archiving, but only an admin lifts it:
     * no `ready` version (a trigger refuses one), no deploys, no rollbacks or restore.
     */
    bannedAt: integer("banned_at", { mode: "timestamp_ms" }),
    banReason: text("ban_reason"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("bots_owner_slug_idx").on(t.ownerId, t.slug)],
);

export type { CheckReport, DeployMeta, VersionStatus };
export { versionStatuses };

export const versions = sqliteTable(
  "versions",
  {
    id: id(),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    /** 1, 2, 3… per bot. */
    n: integer("n").notNull(),
    status: text("status", { enum: versionStatuses }).notNull().default("validating"),
    /** R2 keys in `BUNDLES` and `SOURCES`. */
    bundleKey: text("bundle_key").notNull(),
    sourceKey: text("source_key").notNull(),
    report: text("report", { mode: "json" }).$type<CheckReport>(),
    /** What the CLI sent along (`cliVersion`, `sdkVersion`, `message`). */
    meta: text("meta", { mode: "json" }).$type<DeployMeta>(),
    /** `Idempotency-Key` of the deploy request, so a retried upload doesn't make a second version. */
    idempotencyKey: text("idempotency_key"),
    /**
     * When the deploy API put the `CheckJob` on `CHECKS_QUEUE`. `null` on a `validating` row means
     * the deploy is still in flight; on a `rejected` row, that it failed before being queued (it
     * doesn't count against the daily quota).
     */
    enqueuedAt: integer("enqueued_at", { mode: "timestamp_ms" }),
    /**
     * Every life of the version (alive ones too). Kept by triggers on `lives` (migration
     * `0002_page_counters`), so pages never count `lives` rows. Writers need do nothing.
     */
    livesCount: integer("lives_count").notNull().default(0),
    /**
     * When the version last became `ready` (checks passed, or the owner rolled back to it). Its
     * rating covers lives started since then: a rollback starts the rating over (see
     * `src/server/bot-admin.ts`). `null` if it hasn't been `ready` since migration 0003.
     */
    activatedAt: integer("activated_at", { mode: "timestamp_ms" }),
    /**
     * Position in the order of status changes, for the matchmaker's incremental poll
     * (`src/shared/arena.ts`): set to one more than the largest so far when a row is inserted or
     * its `status` or `quarantined_at` changes. Kept by triggers (migrations
     * `0004_ratings_stint_change_seq`, `0008_version_quarantine`); writers need do nothing. D1
     * runs one write transaction at a time, so it grows in commit order, unlike `updated_at`.
     */
    changeSeq: integer("change_seq").notNull().default(0),
    /**
     * Set by the arena's room backstop when the version's lives kept getting cut short by the
     * room's CPU limit and were evicted (`apps/arena/src/room.ts`). The version stays `ready`
     * (it isn't a ban) but the matchmaker starts no lives of it until an admin clears this
     * (`src/shared/arena.ts`, "Quarantine"). `quarantine_reason` says what happened, for people.
     */
    quarantinedAt: integer("quarantined_at", { mode: "timestamp_ms" }),
    quarantineReason: text("quarantine_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("versions_change_seq_idx").on(t.changeSeq),
    // Bot page: versions newest first. No index on `status` alone: it would steer the
    // leaderboard query away from `ratings_rank_idx`.
    uniqueIndex("versions_bot_n_idx").on(t.botId, t.n),
    uniqueIndex("versions_bot_idempotency_idx").on(t.botId, t.idempotencyKey),
    // A bot has at most one active version.
    uniqueIndex("versions_bot_ready_idx").on(t.botId).where(sql`status = 'ready'`),
    check("versions_status_check", oneOf(t.status, versionStatuses)),
  ],
);

export const activationKinds = ["activate", "deactivate", "archive_bot"] as const;
export type ActivationKind = (typeof activationKinds)[number];

/**
 * Every change of a bot's active version made from the site (`src/server/bot-admin.ts`): a
 * rollback (`activate`), archiving the active version (`deactivate`) or the whole bot. An audit
 * log, and how rollbacks count against the daily deploy quota. Versions the checks make `ready`
 * aren't logged here; they are `versions` rows created that day.
 */
export const activations = sqliteTable(
  "activations",
  {
    id: id(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: activationKinds }).notNull(),
    /** The version made active; `null` when the bot was left without one. */
    versionId: text("version_id").references(() => versions.id, { onDelete: "cascade" }),
    /** The version that was active before, if any. */
    previousVersionId: text("previous_version_id").references(() => versions.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (t) => [
    // Daily quota: an author's rollbacks today.
    index("activations_owner_created_idx").on(t.ownerId, t.createdAt),
    index("activations_bot_idx").on(t.botId),
    check("activations_kind_check", oneOf(t.kind, activationKinds)),
  ],
);

/** Mirrors `DeathCause` in @zerosnake/engine. */
export const deathCauses = ["collision", "wall", "timeout", "error", "retired"] as const;
export type DeathCauseColumn = (typeof deathCauses)[number];

export const lives = sqliteTable(
  "lives",
  {
    id: id(),
    versionId: text("version_id")
      .notNull()
      .references(() => versions.id, { onDelete: "cascade" }),
    /** RoomDO id the life was played in. */
    room: text("room").notNull(),
    startTick: integer("start_tick").notNull(),
    /** `null` while the snake is alive. */
    endTick: integer("end_tick"),
    score: integer("score").notNull().default(0),
    lengthMax: integer("length_max").notNull().default(0),
    kills: integer("kills").notNull().default(0),
    deathCause: text("death_cause", { enum: deathCauses }),
    /** Killer's version id, or `house:<name>` for a house bot. */
    killer: text("killer"),
    /** R2 keys in `REPLAYS` (room chunk at the death) and `TRACES`. */
    replayKey: text("replay_key"),
    traceKey: text("trace_key"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull().default(now),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    /**
     * Position in the order lives finished (were written with an `end_tick`), for the rating
     * job's cursor (`src/server/ratings.ts`). Set by triggers from `rating_progress` (migration
     * `0007_rating_job`); writers need do nothing. `null` while the snake is alive. Unlike
     * `rowid`, never reused after a delete and never renumbered.
     */
    seq: integer("seq"),
  },
  (t) => [
    // Bot page: a version's lives, latest first (last 200, daily quota).
    index("lives_version_ended_idx").on(t.versionId, t.endedAt),
    index("lives_room_idx").on(t.room, t.startTick),
    // Rating job: lives finished after its cursor, and a version's lives when it rebuilds one.
    uniqueIndex("lives_seq_idx").on(t.seq),
    index("lives_version_seq_idx").on(t.versionId, t.seq),
    check("lives_death_cause_check", oneOf(t.deathCause, deathCauses)),
  ],
);

/**
 * Kills by a room's CPU limit that named a call of this version (apps/arena `room/backstop.ts`),
 * from every room: enough of them within a week quarantine the version even when each life is
 * killed too rarely for its room to evict it (`src/shared/arena.ts`, "Quarantine"). Written by
 * rooms, at least once (`id` is the room's). `retracted` when the room later saw a kill that named
 * nobody, which only a restart can be: its kills since the last such one weren't evidence.
 */
export const versionKills = sqliteTable(
  "version_kills",
  {
    id: text("id").primaryKey(),
    versionId: text("version_id")
      .notNull()
      .references(() => versions.id, { onDelete: "cascade" }),
    room: text("room").notNull(),
    lifeId: text("life_id").notNull(),
    /** Room tick of the call the kill interrupted. */
    tick: integer("tick").notNull(),
    retracted: integer("retracted", { mode: "boolean" }).notNull().default(false),
    at: integer("at", { mode: "timestamp_ms" }).notNull(),
  },
  // Counting a version's kills within the window.
  (t) => [index("version_kills_version_at_idx").on(t.versionId, t.at)],
);

export const ratings = sqliteTable(
  "ratings",
  {
    versionId: text("version_id")
      .primaryKey()
      .references(() => versions.id, { onDelete: "cascade" }),
    /** Mean score over the last 200 lives. */
    mean: real("mean").notNull(),
    /** Half-width of the 95% confidence interval around `mean`. */
    ci: real("ci").notNull(),
    nLives: integer("n_lives").notNull(),
    /**
     * The `versions.activated_at` of the stint this rating covers. A trigger (migration
     * `0004_ratings_stint_change_seq`) ignores inserts and updates whose `activated_at` isn't the
     * version's current one, so a writer that read the version before a rollback can't bring the
     * old rating back (`src/shared/arena.ts`).
     */
    activatedAt: integer("activated_at", { mode: "timestamp_ms" }),
    /**
     * `mean - ci`, the leaderboard's sort key (as in `@zerosnake/rating`'s `leaderboard()`): a
     * lucky 30-life mean doesn't outrank a better bot with a tighter interval. Generated, so
     * nothing writes it.
     */
    lowerBound: real("lower_bound").generatedAlwaysAs(sql`mean - ci`, { mode: "virtual" }),
    /**
     * `encodeWindow()` of `@zerosnake/rating`: the scores of the last 200 counted lives, oldest
     * first, which the next update starts from. `null` on rows written before migration
     * `0007_rating_job`.
     */
    recentScores: text("recent_scores"),
    /**
     * The rating covers the stint's counted lives with `lives.seq` up to this. `null` means
     * "rebuild me from `lives`": the rating job does so within a few runs (how to rebuild a
     * rating by hand, see `src/server/ratings.ts`).
     */
    lifeSeq: integer("life_seq"),
    updatedAt: updatedAt(),
  },
  // Leaderboard: highest lower bound first (`ratings_rank_idx`), filtered by `n_lives >= 30`.
  (t) => [
    index("ratings_mean_idx").on(t.mean),
    // Leaderboard order, `lower_bound DESC, ci ASC, n_lives DESC, version_id`, read backwards so
    // rows come out sorted and `LIMIT` stops early.
    index("ratings_rank_idx").on(
      t.lowerBound,
      sql`${t.ci} DESC`,
      t.nLives,
      sql`${t.versionId} DESC`,
    ),
    // Rating job: rows waiting for a rebuild.
    index("ratings_rebuild_idx").on(t.versionId).where(sql`life_seq IS NULL`),
  ],
);

/**
 * The rating job's progress, a single row (`id = 1`, made by the migration). Triggers on `lives`
 * number each finished life with `assigned_seq + 1` (`lives.seq`); the job has applied every
 * life up to `rated_seq` to `ratings`. `assigned_seq - rated_seq` is its backlog.
 */
export const ratingProgress = sqliteTable(
  "rating_progress",
  {
    id: integer("id").primaryKey(),
    assignedSeq: integer("assigned_seq").notNull().default(0),
    ratedSeq: integer("rated_seq").notNull().default(0),
    /** One more on every commit of the job; its writes are guarded by it, so runs never interleave. */
    rev: integer("rev").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [check("rating_progress_singleton", sql`${t.id} = 1`)],
);

// ─── Operations ─────────────────────────────────────────────────────────────────────────────────

/**
 * The kill switch: a single row (`id = 1`, made by the migration) that admins change from
 * `/admin`. `paused` stops the arena (the matchmaker and rooms read it, contract in
 * `src/shared/arena.ts`); `deploys_paused` makes the deploy API refuse new versions.
 */
export const arenaControl = sqliteTable(
  "arena_control",
  {
    id: integer("id").primaryKey(),
    paused: integer("paused", { mode: "boolean" }).notNull().default(false),
    deploysPaused: integer("deploys_paused", { mode: "boolean" }).notNull().default(false),
    /** Why `paused` last changed, shown on `/admin` and logged; free text. */
    reason: text("reason"),
    /** Why `deploys_paused` last changed; the deploy API's 503 quotes it. */
    deploysReason: text("deploys_reason"),
    /** Admin user id of the last change. */
    updatedBy: text("updated_by"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [check("arena_control_singleton", sql`${t.id} = 1`)],
);

export const moderationActionKinds = [
  "pause_arena",
  "resume_arena",
  "pause_deploys",
  "resume_deploys",
  "ban_user",
  "unban_user",
  "ban_bot",
  "unban_bot",
  "ban_version",
] as const;
export type ModerationActionKind = (typeof moderationActionKinds)[number];

/**
 * Audit log of admin actions. Targets are plain ids, not foreign keys, so the record outlives
 * a deleted account.
 */
export const moderationActions = sqliteTable(
  "moderation_actions",
  {
    id: id(),
    adminId: text("admin_id").notNull(),
    action: text("action", { enum: moderationActionKinds }).notNull(),
    targetUserId: text("target_user_id"),
    targetBotId: text("target_bot_id"),
    targetVersionId: text("target_version_id"),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("moderation_actions_created_idx").on(t.createdAt),
    check("moderation_actions_action_check", oneOf(t.action, moderationActionKinds)),
  ],
);

export const authSchema = { users, accounts, verifications, deviceCodes };
