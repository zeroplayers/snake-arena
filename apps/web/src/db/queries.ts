import { DEFAULT_RATING_CONFIG, minRankedTicks } from "@zerosnake/rating";
import { and, asc, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import type { BotSummary, LeaderboardEntry, LeaderboardQuery, Profile } from "../lib/api";
import type { Db } from ".";
import { bots, ratings, users, versions } from "./schema";

/**
 * A version enters the leaderboard once its counted lives add up to this many ticks alive: an
 * hour of game time (`minMinutes` of `@zerosnake/rating`). Stored ratings have two lives at least.
 */
export const RANKED_MIN_TICKS = minRankedTicks(DEFAULT_RATING_CONFIG);
/** `RANKED_MIN_TICKS` in minutes, for the pages. */
export const RANKED_MIN_MINUTES = DEFAULT_RATING_CONFIG.minMinutes;
/** Ticks per minute of game time. */
export const TICKS_PER_MINUTE = DEFAULT_RATING_CONFIG.ticksPerMinute;

/** Minutes alive behind a rating, from `ratings.alive_ticks`. */
const ratedMinutes = sql<
  number | null
>`${ratings.aliveTicks} / ${sql.raw(`${TICKS_PER_MINUTE}.0`)}`;

export async function getProfile(db: Db, username: string): Promise<Profile | null> {
  const [user] = await db
    .select({
      id: users.id,
      username: users.username,
      image: users.image,
      createdAt: users.createdAt,
    })
    .from(users)
    // A banned user's profile is gone while the ban lasts.
    .where(and(eq(users.username, username.toLowerCase()), isNull(users.bannedAt)))
    .limit(1);
  if (!user?.username) return null;

  const botRows: BotSummary[] = await db
    .select({
      id: bots.id,
      name: bots.name,
      slug: bots.slug,
      activeVersion: versions.n,
      rating: ratings.mean,
      ratingCi: ratings.ci,
      ratedLives: ratings.nLives,
      ratedMinutes,
      // Per-version counters (kept by triggers), not a count over `lives`.
      lives: sql<number>`(
        SELECT coalesce(sum(v.lives_count), 0) FROM ${versions} AS v WHERE v.bot_id = ${bots.id}
      )`,
    })
    .from(bots)
    .leftJoin(versions, and(eq(versions.botId, bots.id), eq(versions.status, "ready")))
    .leftJoin(ratings, eq(ratings.versionId, versions.id))
    // Archived and banned bots drop off the profile; their pages stay reachable by URL.
    .where(and(eq(bots.ownerId, user.id), isNull(bots.archivedAt), isNull(bots.bannedAt)))
    .orderBy(bots.createdAt);

  return {
    username: user.username,
    avatarUrl: user.image,
    joinedAt: user.createdAt.toISOString(),
    bots: botRows,
  };
}

/**
 * Ranked by the lower bound of the rating (points per minute alive), `mean - ci`, then the
 * narrower interval, more time alive and the version id: the order of `leaderboard()` in
 * `@zerosnake/rating`. Ranking by the point estimate alone rewards redeploying until one version
 * gets a lucky first hour.
 *
 * `CROSS JOIN` pins `ratings` as SQLite's outer loop, so rows come out of `ratings_rank_idx`
 * already in order and `LIMIT` stops early. With a plain join the planner prefers scanning every
 * active version and sorting them all.
 */
export function leaderboardQuery(db: Db, { limit = 50, offset = 0 }: LeaderboardQuery = {}) {
  return db
    .select({
      botId: bots.id,
      botName: bots.name,
      botSlug: bots.slug,
      author: users.username,
      version: versions.n,
      rating: ratings.mean,
      ratingCi: ratings.ci,
      lowerBound: ratings.lowerBound,
      ratedLives: ratings.nLives,
      ratedMinutes: sql<number>`${ratings.aliveTicks} / ${sql.raw(`${TICKS_PER_MINUTE}.0`)}`,
      lives: versions.livesCount,
    })
    .from(ratings)
    .crossJoin(versions)
    .innerJoin(bots, eq(bots.id, versions.botId))
    .innerJoin(users, eq(users.id, bots.ownerId))
    .where(
      and(
        eq(versions.id, ratings.versionId),
        eq(versions.status, "ready"),
        // Never true together with `ready` (archiving or banning a bot, or banning its author,
        // archives its versions), but the leaderboard must not depend on every writer keeping
        // that up.
        isNull(bots.archivedAt),
        isNull(bots.bannedAt),
        isNull(users.bannedAt),
        // A version the arena quarantined (`src/shared/arena.ts`, "Quarantine") stops playing, so
        // its rank would stay frozen: a lucky leader could get itself quarantined to keep it.
        // Checked on the version row the join already looks up by key, so the plan is unchanged.
        isNull(versions.quarantinedAt),
        gte(ratings.aliveTicks, RANKED_MIN_TICKS),
        // No interval: too little evidence yet (an hour-long life and a death at spawn).
        isNotNull(ratings.ci),
      ),
    )
    .orderBy(
      desc(ratings.lowerBound),
      asc(ratings.ci),
      desc(ratings.aliveTicks),
      asc(ratings.versionId),
    )
    .limit(limit)
    .offset(offset);
}

export async function getLeaderboard(db: Db, query: LeaderboardQuery = {}) {
  const offset = query.offset ?? 0;
  const rows = await leaderboardQuery(db, query);
  return rows.map(
    (row, i): LeaderboardEntry => ({
      ...row,
      author: row.author ?? "",
      // Ranked rows always have an interval (`ci IS NOT NULL` above).
      ratingCi: row.ratingCi ?? 0,
      lowerBound: row.lowerBound ?? row.rating - (row.ratingCi ?? 0),
      rank: offset + i + 1,
    }),
  );
}
