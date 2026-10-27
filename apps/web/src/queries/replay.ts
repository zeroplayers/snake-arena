/**
 * Read-only queries behind `/replay/{lifeId}`: the life, the replay chunk recorded at its death
 * (`lives.replay_key` in `REPLAYS`), and who else played in the room during that chunk, so the
 * viewer can name every snake.
 *
 * Assumes the room spawns each life with the engine snake id equal to `lives.id`. Snakes that
 * match no life (house bots) keep the author the replay recorded.
 */
import { and, eq, gte, isNull, lte, or } from "drizzle-orm";
import type { Db } from "../db";
import { bots, type DeathCauseColumn, lives, users, versions } from "../db/schema";

export interface ReplayLife {
  id: string;
  room: string;
  startTick: number;
  endTick: number | null;
  score: number;
  kills: number;
  deathCause: DeathCauseColumn | null;
  endedAt: string | null;
  author: string;
  botName: string;
  botSlug: string;
  version: number;
  /** Whether a replay chunk was recorded for this life. */
  hasReplay: boolean;
}

/** A life in the room, by engine snake id (= `lives.id`). */
export interface Participant {
  id: string;
  author: string;
  botName: string;
  botSlug: string;
  version: number;
}

const lifeColumns = {
  id: lives.id,
  author: users.username,
  botName: bots.name,
  botSlug: bots.slug,
  version: versions.n,
};

export async function getReplayLife(db: Db, lifeId: string): Promise<ReplayLife | null> {
  const [row] = await db
    .select({
      ...lifeColumns,
      room: lives.room,
      startTick: lives.startTick,
      endTick: lives.endTick,
      score: lives.score,
      kills: lives.kills,
      deathCause: lives.deathCause,
      endedAt: lives.endedAt,
      replayKey: lives.replayKey,
    })
    .from(lives)
    .innerJoin(versions, eq(versions.id, lives.versionId))
    .innerJoin(bots, eq(bots.id, versions.botId))
    .innerJoin(users, eq(users.id, bots.ownerId))
    .where(eq(lives.id, lifeId))
    .limit(1);
  if (!row?.author) return null;
  const { replayKey, endedAt, ...life } = row;
  return {
    ...life,
    author: row.author,
    endedAt: endedAt?.toISOString() ?? null,
    hasReplay: replayKey !== null,
  };
}

/** R2 key of the life's replay chunk, kept off the page data. */
export async function getReplayKey(db: Db, lifeId: string): Promise<string | null> {
  const [row] = await db
    .select({ key: lives.replayKey })
    .from(lives)
    .where(eq(lives.id, lifeId))
    .limit(1);
  return row?.key ?? null;
}

/** Lives in `room` that overlap ticks `[from, to]` (`lives_room_idx`). */
export async function getParticipants(
  db: Db,
  room: string,
  from: number,
  to: number,
): Promise<Participant[]> {
  const rows = await db
    .select(lifeColumns)
    .from(lives)
    .innerJoin(versions, eq(versions.id, lives.versionId))
    .innerJoin(bots, eq(bots.id, versions.botId))
    .innerJoin(users, eq(users.id, bots.ownerId))
    .where(
      and(
        eq(lives.room, room),
        lte(lives.startTick, to),
        or(isNull(lives.endTick), gte(lives.endTick, from)),
      ),
    );
  return rows.flatMap((r) => (r.author ? [{ ...r, author: r.author }] : []));
}
