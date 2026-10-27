/**
 * Read-only queries behind the bot page (`/@{username}/{bot}`): the bot, a page of its versions
 * with their ratings, and the recent lives of one version.
 *
 * Ratings are read from the stored `ratings` columns (written by apps/arena); nothing here
 * computes them. Life totals come from `versions.lives_count` (kept by triggers), and every query
 * on `lives` is bounded by an index and a `LIMIT`, so a page view costs the same after months of
 * play.
 */
import { and, count, desc, eq, isNotNull, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Db } from "../db";
import {
  bots,
  type CheckReport,
  type DeathCauseColumn,
  lives,
  ratings,
  users,
  type VersionStatus,
  versions,
} from "../db/schema";
import type { VersionQuarantine } from "../shared/arena";

/** Finished lives listed for the selected version. */
export const RECENT_LIVES = 20;
/** Versions per page of the versions table and the rating chart. */
export const VERSIONS_PER_PAGE = 50;
/** Death causes are counted over this many latest finished lives. */
export const CAUSES_WINDOW = 200;

export interface BotPage {
  author: { username: string; avatarUrl: string | null };
  bot: {
    id: string;
    name: string;
    slug: string;
    createdAt: string;
    /** Set when the owner archived it; the page stays up. */
    archivedAt: string | null;
  };
  /** The active (`ready`) version, if any. */
  active: VersionRow | null;
  /** One page of versions, newest first. */
  versions: VersionRow[];
  /** 1-based page of `versions`. */
  page: number;
  /** Whether there are older versions after this page. */
  hasOlder: boolean;
  /** The version the lives and sources are shown for; `null` when the bot has no versions. */
  selected: SelectedVersion | null;
}

export interface VersionRow {
  id: string;
  n: number;
  status: VersionStatus;
  createdAt: string;
  rating: number | null;
  /** Half-width of the 95% confidence interval around `rating`. */
  ratingCi: number | null;
  /** Lives behind `rating` (`ratings.n_lives`). */
  ratedLives: number | null;
  /** Every life the version played. */
  lives: number;
  /** First failed check of a rejected version, as the CLI shows it. */
  rejection: string | null;
  /** Set when the arena quarantined it (`src/shared/arena.ts`): no new lives. */
  quarantine: VersionQuarantine | null;
}

export interface SelectedVersion {
  id: string;
  n: number;
  /** Finished lives, latest first. */
  recentLives: LifeRow[];
  /** The latest `CAUSES_WINDOW` finished lives by how they ended, most common first. */
  causes: { cause: DeathCauseColumn; count: number }[];
}

export interface LifeRow {
  id: string;
  score: number;
  lengthMax: number;
  kills: number;
  /** Ticks alive. */
  ticks: number | null;
  deathCause: DeathCauseColumn | null;
  killer: Killer | null;
  startedAt: string;
  endedAt: string | null;
  /** Whether `/replay/{id}` has a recording to show. */
  hasReplay: boolean;
  /** Recorded, but deleted by the replay retention (`src/shared/replay.ts`). */
  replayExpired: boolean;
  /** Whether a trace was recorded (its owner can read it for `TRACE_RETENTION_DAYS`). */
  hasTrace: boolean;
}

export type Killer =
  | { kind: "house"; name: string }
  | { kind: "bot"; author: string; botName: string; botSlug: string; version: number }
  /** A version id that no longer exists (its bot was deleted). */
  | { kind: "unknown" };

export interface BotPageOptions {
  /** Version whose lives are listed; by default the active one, else the newest. */
  version?: number;
  /** Page of the versions table, 1-based. */
  page?: number;
}

/**
 * `null` if the author or the bot doesn't exist, or `version` isn't a version of it. A page
 * past the last one comes back with no versions.
 */
export async function getBotPage(
  db: Db,
  username: string,
  slug: string,
  { version, page = 1 }: BotPageOptions = {},
): Promise<BotPage | null> {
  const [bot] = await db
    .select({
      id: bots.id,
      name: bots.name,
      slug: bots.slug,
      createdAt: bots.createdAt,
      archivedAt: bots.archivedAt,
      username: users.username,
      avatarUrl: users.image,
    })
    .from(bots)
    .innerJoin(users, eq(users.id, bots.ownerId))
    .where(and(eq(users.username, username.toLowerCase()), eq(bots.slug, slug.toLowerCase())))
    .limit(1);
  if (!bot?.username) return null;

  const [rows, [active], [chosen]] = await Promise.all([
    // `versions_bot_n_idx`, one row past the page to tell whether there are more.
    versionRows(
      db,
      eq(versions.botId, bot.id),
      VERSIONS_PER_PAGE + 1,
      (page - 1) * VERSIONS_PER_PAGE,
    ),
    // `versions_bot_ready_idx`.
    versionRows(db, and(eq(versions.botId, bot.id), eq(versions.status, "ready")), 1),
    version === undefined
      ? versionRows(db, eq(versions.botId, bot.id), 1)
      : versionRows(db, and(eq(versions.botId, bot.id), eq(versions.n, version)), 1),
  ]);
  if (version !== undefined && !chosen) return null;
  const pick = version === undefined ? (active ?? chosen) : chosen;

  return {
    author: { username: bot.username, avatarUrl: bot.avatarUrl },
    bot: {
      id: bot.id,
      name: bot.name,
      slug: bot.slug,
      createdAt: bot.createdAt.toISOString(),
      archivedAt: bot.archivedAt?.toISOString() ?? null,
    },
    active: active ?? null,
    versions: rows.slice(0, VERSIONS_PER_PAGE),
    page,
    hasOlder: rows.length > VERSIONS_PER_PAGE,
    selected: pick
      ? {
          id: pick.id,
          n: pick.n,
          recentLives: await recentLives(db, pick.id),
          causes: await deathCauses(db, pick.id),
        }
      : null,
  };
}

/** Versions matching `where` with their ratings, newest first. */
async function versionRows(db: Db, where: SQL | undefined, limit: number, offset = 0) {
  const rows = await db
    .select({
      id: versions.id,
      n: versions.n,
      status: versions.status,
      report: versions.report,
      quarantinedAt: versions.quarantinedAt,
      quarantineReason: versions.quarantineReason,
      createdAt: versions.createdAt,
      lives: versions.livesCount,
      rating: ratings.mean,
      ratingCi: ratings.ci,
      ratedLives: ratings.nLives,
    })
    .from(versions)
    .leftJoin(ratings, eq(ratings.versionId, versions.id))
    .where(where)
    .orderBy(desc(versions.n))
    .limit(limit)
    .offset(offset);
  return rows.map(
    ({ report, createdAt, quarantinedAt, quarantineReason, ...v }): VersionRow => ({
      ...v,
      createdAt: createdAt.toISOString(),
      rejection: v.status === "rejected" ? rejection(report) : null,
      quarantine: quarantinedAt
        ? { at: quarantinedAt.toISOString(), reason: quarantineReason ?? "" }
        : null,
    }),
  );
}

function rejection(report: CheckReport | null): string | null {
  const failed = report?.checks.find((c) => !c.ok);
  if (!failed) return null;
  return failed.message ? `${failed.name}: ${failed.message}` : failed.name;
}

export const killerVersion = alias(versions, "killer_version");
export const killerBot = alias(bots, "killer_bot");
export const killerUser = alias(users, "killer_user");

/** Latest finished lives of a version (`lives_version_ended_idx`), killers resolved. */
export async function recentLives(db: Db, versionId: string, limit = RECENT_LIVES) {
  const rows = await db
    .select({
      id: lives.id,
      score: lives.score,
      lengthMax: lives.lengthMax,
      kills: lives.kills,
      startTick: lives.startTick,
      endTick: lives.endTick,
      deathCause: lives.deathCause,
      killer: lives.killer,
      replayKey: lives.replayKey,
      replayExpiredAt: lives.replayExpiredAt,
      traceKey: lives.traceKey,
      startedAt: lives.startedAt,
      endedAt: lives.endedAt,
      killerAuthor: killerUser.username,
      killerBotName: killerBot.name,
      killerBotSlug: killerBot.slug,
      killerVersion: killerVersion.n,
    })
    .from(lives)
    .leftJoin(killerVersion, eq(killerVersion.id, lives.killer))
    .leftJoin(killerBot, eq(killerBot.id, killerVersion.botId))
    .leftJoin(killerUser, eq(killerUser.id, killerBot.ownerId))
    .where(and(eq(lives.versionId, versionId), isNotNull(lives.endedAt)))
    .orderBy(desc(lives.endedAt))
    .limit(limit);

  return rows.map(
    (r): LifeRow => ({
      id: r.id,
      score: r.score,
      lengthMax: r.lengthMax,
      kills: r.kills,
      ticks: r.endTick === null ? null : r.endTick - r.startTick,
      deathCause: r.deathCause,
      killer: killer(r),
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt?.toISOString() ?? null,
      hasReplay: r.replayKey !== null && r.replayExpiredAt === null,
      replayExpired: r.replayKey !== null && r.replayExpiredAt !== null,
      hasTrace: r.traceKey !== null,
    }),
  );
}

export function killer(r: {
  killer: string | null;
  killerAuthor: string | null;
  killerBotName: string | null;
  killerBotSlug: string | null;
  killerVersion: number | null;
}): Killer | null {
  if (r.killer === null) return null;
  if (r.killer.startsWith("house:")) return { kind: "house", name: r.killer.slice(6) };
  if (r.killerAuthor && r.killerBotName && r.killerBotSlug && r.killerVersion !== null) {
    return {
      kind: "bot",
      author: r.killerAuthor,
      botName: r.killerBotName,
      botSlug: r.killerBotSlug,
      version: r.killerVersion,
    };
  }
  return { kind: "unknown" };
}

/** How the latest `window` finished lives of a version ended (`lives_version_ended_idx`). */
export async function deathCauses(db: Db, versionId: string, window = CAUSES_WINDOW) {
  const recent = db
    .select({ cause: lives.deathCause })
    .from(lives)
    .where(and(eq(lives.versionId, versionId), isNotNull(lives.endedAt)))
    .orderBy(desc(lives.endedAt))
    .limit(window)
    .as("recent");
  const n = count();
  const rows = await db
    .select({ cause: recent.cause, count: n })
    .from(recent)
    .groupBy(recent.cause)
    .orderBy(desc(n));
  return rows.flatMap((r) => (r.cause ? [{ cause: r.cause, count: r.count }] : []));
}
