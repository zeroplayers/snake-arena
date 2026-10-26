import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { BotSummary, LeaderboardEntry, LeaderboardQuery, Profile } from "../lib/api";
import type { Db } from ".";
import { bots, lives, ratings, users, versions } from "./schema";

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
      lives: sql<number>`(
        SELECT count(*) FROM ${lives}
        JOIN ${versions} AS v ON v.id = ${lives.versionId}
        WHERE v.bot_id = ${bots.id}
      )`,
    })
    .from(bots)
    .leftJoin(versions, and(eq(versions.botId, bots.id), eq(versions.status, "ready")))
    .leftJoin(ratings, eq(ratings.versionId, versions.id))
    .where(eq(bots.ownerId, user.id))
    .orderBy(bots.createdAt);

  return {
    username: user.username,
    avatarUrl: user.image,
    joinedAt: user.createdAt.toISOString(),
    bots: botRows,
  };
}

/**
 * `CROSS JOIN` pins `ratings` as SQLite's outer loop, so rows come out of `ratings_mean_idx`
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
      lives: ratings.nLives,
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
    .orderBy(desc(ratings.mean))
    .limit(limit)
    .offset(offset);
}

export async function getLeaderboard(db: Db, query: LeaderboardQuery = {}) {
  const offset = query.offset ?? 0;
  const rows = await leaderboardQuery(db, query);
  return rows.map(
    (row, i): LeaderboardEntry => ({ ...row, author: row.author ?? "", rank: offset + i + 1 }),
  );
}
