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
  /** Chosen on first sign-in (username plugin), lowercase. `null` until then. */
  username: text("username").unique(),
  displayUsername: text("display_username"),
  /** GitHub login at sign-in, used to suggest a username. */
  githubLogin: text("github_login"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessionKinds = ["web", "cli"] as const;
export type SessionKind = (typeof sessionKinds)[number];

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
    /** `cli` for tokens issued by the device flow (`zerosnake login`), listed in settings. */
    kind: text("kind", { enum: sessionKinds }).notNull().default("web"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("sessions_user_id_idx").on(t.userId, t.kind),
    check("sessions_kind_check", oneOf(t.kind, sessionKinds)),
  ],
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

// ─── Arena ──────────────────────────────────────────────────────────────────────────────────────

export const bots = sqliteTable(
  "bots",
  {
    id: id(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** URL segment, unique per owner: `/@{username}/{slug}`. */
    slug: text("slug").notNull(),
    /** Skin id; `null` means the default skin. */
    skin: text("skin"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("bots_owner_slug_idx").on(t.ownerId, t.slug)],
);

export const versionStatuses = ["validating", "ready", "rejected", "archived"] as const;
export type VersionStatus = (typeof versionStatuses)[number];

/** Result of the deploy checks, shown by the CLI when a version is rejected. */
export interface CheckReport {
  ok: boolean;
  checks: { name: string; ok: boolean; message?: string }[];
  /** Mean score in the qualification run, if it got that far. */
  qualificationScore?: number;
}

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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Bot page: versions newest first. No index on `status` alone: it would steer the
    // leaderboard query away from `ratings_mean_idx`.
    uniqueIndex("versions_bot_n_idx").on(t.botId, t.n),
    // A bot has at most one active version.
    uniqueIndex("versions_bot_ready_idx").on(t.botId).where(sql`status = 'ready'`),
    check("versions_status_check", oneOf(t.status, versionStatuses)),
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
  },
  (t) => [
    // Bot page and rating: a version's lives, latest first (last 200, daily quota).
    index("lives_version_ended_idx").on(t.versionId, t.endedAt),
    index("lives_room_idx").on(t.room, t.startTick),
    check("lives_death_cause_check", oneOf(t.deathCause, deathCauses)),
  ],
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
    updatedAt: updatedAt(),
  },
  // Leaderboard: highest mean first, filtered by `n_lives >= 30`.
  (t) => [index("ratings_mean_idx").on(t.mean)],
);

export const authSchema = { users, sessions, accounts, verifications, deviceCodes };
