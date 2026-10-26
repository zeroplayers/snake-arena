/**
 * Read-only queries behind the bot page (`/@{username}/{bot}`): the bot, every version with its
 * rating, and the recent lives of one version.
 *
 * Ratings are read from the stored `ratings` columns (written by apps/arena); nothing here
 * computes them.
 */
import { and, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
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

/** Finished lives listed for the selected version. */
export const RECENT_LIVES = 20;

export interface BotPage {
  author: { username: string; avatarUrl: string | null };
  bot: { id: string; name: string; slug: string; createdAt: string };
  /** Newest first. */
  versions: VersionRow[];
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
  /** Lives behind `rating` (at most the last 200). */
  ratedLives: number | null;
  /** Every life the version played. */
  lives: number;
  /** First failed check of a rejected version, as the CLI shows it. */
  rejection: string | null;
}

export interface SelectedVersion {
  id: string;
  n: number;
  /** Finished lives, latest first. */
  recentLives: LifeRow[];
  /** Every finished life of the version by how it ended, most common first. */
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
  endedAt: string | null;
  /** Whether `/replay/{id}` has a recording to show. */
  hasReplay: boolean;
}

export type Killer =
  | { kind: "house"; name: string }
  | { kind: "bot"; author: string; botName: string; botSlug: string; version: number }
  /** A version id that no longer exists (its bot was deleted). */
  | { kind: "unknown" };

/**
 * `versionN` picks the version whose lives are listed; by default the active (`ready`) one,
 * else the newest. `null` if the author or the bot doesn't exist, or `versionN` isn't a version
 * of it.
 */
export async function getBotPage(
  db: Db,
  username: string,
  slug: string,
  versionN?: number,
): Promise<BotPage | null> {
  const [bot] = await db
    .select({
      id: bots.id,
      name: bots.name,
      slug: bots.slug,
      createdAt: bots.createdAt,
      username: users.username,
      avatarUrl: users.image,
    })
    .from(bots)
    .innerJoin(users, eq(users.id, bots.ownerId))
    .where(and(eq(users.username, username.toLowerCase()), eq(bots.slug, slug.toLowerCase())))
    .limit(1);
  if (!bot?.username) return null;

  const versionRows = await db
    .select({
      id: versions.id,
      n: versions.n,
      status: versions.status,
      report: versions.report,
      createdAt: versions.createdAt,
      rating: ratings.mean,
      ratingCi: ratings.ci,
      ratedLives: ratings.nLives,
    })
    .from(versions)
    .leftJoin(ratings, eq(ratings.versionId, versions.id))
    .where(eq(versions.botId, bot.id))
    .orderBy(desc(versions.n));

  const counts = new Map<string, number>();
  if (versionRows.length > 0) {
    const rows = await db
      .select({ versionId: lives.versionId, n: count() })
      .from(lives)
      .where(
        inArray(
          lives.versionId,
          versionRows.map((v) => v.id),
        ),
      )
      .groupBy(lives.versionId);
    for (const row of rows) counts.set(row.versionId, row.n);
  }

  const pick =
    versionN === undefined
      ? (versionRows.find((v) => v.status === "ready") ?? versionRows[0])
      : versionRows.find((v) => v.n === versionN);
  if (versionN !== undefined && !pick) return null;

  return {
    author: { username: bot.username, avatarUrl: bot.avatarUrl },
    bot: { id: bot.id, name: bot.name, slug: bot.slug, createdAt: bot.createdAt.toISOString() },
    versions: versionRows.map(
      (v): VersionRow => ({
        id: v.id,
        n: v.n,
        status: v.status,
        createdAt: v.createdAt.toISOString(),
        rating: v.rating,
        ratingCi: v.ratingCi,
        ratedLives: v.ratedLives,
        lives: counts.get(v.id) ?? 0,
        rejection: v.status === "rejected" ? rejection(v.report) : null,
      }),
    ),
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

function rejection(report: CheckReport | null): string | null {
  const failed = report?.checks.find((c) => !c.ok);
  if (!failed) return null;
  return failed.message ? `${failed.name}: ${failed.message}` : failed.name;
}

const killerVersion = alias(versions, "killer_version");
const killerBot = alias(bots, "killer_bot");
const killerUser = alias(users, "killer_user");

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
      endedAt: r.endedAt?.toISOString() ?? null,
      hasReplay: r.replayKey !== null,
    }),
  );
}

function killer(r: {
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

/** How a version's finished lives ended. */
export async function deathCauses(db: Db, versionId: string) {
  const n = sql<number>`count(*)`;
  const rows = await db
    .select({ cause: lives.deathCause, count: n })
    .from(lives)
    .where(and(eq(lives.versionId, versionId), isNotNull(lives.deathCause)))
    .groupBy(lives.deathCause)
    .orderBy(desc(n));
  return rows.flatMap((r) => (r.cause ? [{ cause: r.cause, count: r.count }] : []));
}
