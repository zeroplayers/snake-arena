import { and, asc, desc, eq, gte, isNull, sql } from "drizzle-orm";
import type { BotSummary, LeaderboardEntry, LeaderboardQuery, Profile } from "../lib/api";
import type { Db } from ".";
import { bots, ratings, users, versions } from "./schema";

/** A version enters the leaderboard after this many lives. */
export const RANKED_MIN_LIVES = 30;

export async function getProfile(db: Db, username: string): Promise<Profile | null> {
  const [user] = await db
    .select({
      id: users.id,
      username: users.username,
      image: users.image,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.username, username.toLowerCase()))
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
      // Per-version counters (kept by triggers), not a count over `lives`.
      lives: sql<number>`(
        SELECT coalesce(sum(v.lives_count), 0) FROM ${versions} AS v WHERE v.bot_id = ${bots.id}
      )`,
    })
    .from(bots)
    .leftJoin(versions, and(eq(versions.botId, bots.id), eq(versions.status, "ready")))
    .leftJoin(ratings, eq(ratings.versionId, versions.id))
    // Archived bots drop off the profile; their pages stay reachable by URL.
    .where(and(eq(bots.ownerId, user.id), isNull(bots.archivedAt)))
    .orderBy(bots.createdAt);

  return {
    username: user.username,
    avatarUrl: user.image,
    joinedAt: user.createdAt.toISOString(),
    bots: botRows,
  };
}

/**
 * Ranked by the lower bound of the rating, `mean - ci`, then the narrower interval, more lives
 * and the version id: the order of `leaderboard()` in `@zerosnake/rating`. Ranking by the mean
 * alone rewards redeploying until one version gets a lucky 30 lives.
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
        gte(ratings.nLives, RANKED_MIN_LIVES),
      ),
    )
    .orderBy(
      desc(ratings.lowerBound),
      asc(ratings.ci),
      desc(ratings.nLives),
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
      lowerBound: row.lowerBound ?? row.rating - row.ratingCi,
      rank: offset + i + 1,
    }),
  );
}
