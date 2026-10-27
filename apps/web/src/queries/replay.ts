/**
 * Read-only queries behind `/replay/{lifeId}`: the life, the replay chunk recorded at its death
 * (`lives.replay_key` in `REPLAYS`), and who else played in the room during that chunk, so the
 * viewer can name every snake. Chunks older than two days are deleted unless a pinned life needs
 * them (`src/shared/replay.ts`); `lives.replay_expired_at` marks the lives whose chunk is gone.
 *
 * Assumes the room spawns each life with the engine snake id equal to `lives.id`. Snakes that
 * match no life (house bots) keep the author the replay recorded.
 */
import { Buffer } from "node:buffer";
import { REPLAY_VERSION, replayChunkInfo, replayChunkVersion } from "@zerosnake/engine";
import { and, eq, gte, isNull, lte, or } from "drizzle-orm";
import type { Db } from "../db";
import { bots, type DeathCauseColumn, lives, users, versions } from "../db/schema";
import type { ReplayParticipant, ReplayResponse } from "../shared/replay";

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
  /** Whether a replay chunk was recorded for this life (it may have expired since). */
  replayRecorded: boolean;
  /** Recorded, but deleted by the replay retention since. */
  replayExpired: boolean;
}

/** A life in the room, by engine snake id (= `lives.id`). */
export type Participant = ReplayParticipant;

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
      replayExpiredAt: lives.replayExpiredAt,
    })
    .from(lives)
    .innerJoin(versions, eq(versions.id, lives.versionId))
    .innerJoin(bots, eq(bots.id, versions.botId))
    .innerJoin(users, eq(users.id, bots.ownerId))
    .where(eq(lives.id, lifeId))
    .limit(1);
  if (!row?.author) return null;
  const { replayKey, replayExpiredAt, endedAt, ...life } = row;
  return {
    ...life,
    author: row.author,
    endedAt: endedAt?.toISOString() ?? null,
    replayRecorded: replayKey !== null,
    replayExpired: replayKey !== null && replayExpiredAt !== null,
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

export type ReplayRead =
  | { status: "ok"; replay: ReplayResponse }
  /** No such life. */
  | { status: "not_found" }
  /** No chunk was recorded for it (or it can't be read). */
  | { status: "none" }
  /**
   * Recorded, but deleted by the replay retention, or recorded by an engine this one can't play
   * (the round arena before #76). `marked`: `lives.replay_expired_at` says so; otherwise the
   * caller should mark it.
   */
  | { status: "expired"; marked: boolean };

/**
 * The chunk `lifeId` died in, and who played in it (`GET /api/lives/:id/replay`). A chunk missing
 * from R2 counts as expired, marked or not: a life's row is written only once its chunk is in R2.
 * So does one in another format version: no player can show it any more.
 * Read-only: `src/server/replay-api.ts` marks such a life.
 */
export async function readLifeReplay(
  db: Db,
  bucket: R2Bucket,
  lifeId: string,
): Promise<ReplayRead> {
  const life = await getReplayLife(db, lifeId);
  if (!life) return { status: "not_found" };
  if (!life.replayRecorded) return { status: "none" };
  if (life.replayExpired) return { status: "expired", marked: true };
  const key = await getReplayKey(db, lifeId);
  const object = key ? await bucket.get(key) : null;
  if (!object) return { status: "expired", marked: false };
  const bytes = new Uint8Array(await object.arrayBuffer());
  const version = replayChunkVersion(bytes);
  if (version !== null && version !== REPLAY_VERSION) return { status: "expired", marked: false };
  let range: { startTick: number; endTick: number };
  try {
    range = replayChunkInfo(bytes);
  } catch {
    return { status: "none" };
  }
  return {
    status: "ok",
    replay: {
      chunk: Buffer.from(bytes).toString("base64"),
      participants: await getParticipants(db, life.room, range.startTick, range.endTick),
    },
  };
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
