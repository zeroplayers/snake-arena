/**
 * Read-only queries behind `/replay/{lifeId}`: the life, its replay window (the chunks covering
 * its last 10 minutes, ending with the one recorded at its death, `lives.replay_key` in
 * `REPLAYS`), and who else played in the room during them, so the viewer can name every snake.
 * Lives last until the snake dies (up to 24 hours), so a replay never loads a whole life. Chunks
 * older than two days are deleted unless a pinned life needs them (`src/shared/replay.ts`);
 * `lives.replay_expired_at` marks the lives whose death chunk is gone.
 *
 * Assumes the room spawns each life with the engine snake id equal to `lives.id`. Snakes that
 * match no life (house bots) keep the author the replay recorded.
 */
import { Buffer } from "node:buffer";
import {
  CHUNK_TICKS,
  REPLAY_VERSION,
  replayChunkInfo,
  replayChunkVersion,
} from "@zerosnake/engine";
import { and, eq, gte, isNull, lte, or } from "drizzle-orm";
import type { Db } from "../db";
import { bots, type DeathCauseColumn, lives, users, versions } from "../db/schema";
import {
  parseChunkKey,
  REPLAY_WINDOW_MAX_CHUNKS,
  type ReplayParticipant,
  type ReplayResponse,
  replayWindowStart,
} from "../shared/replay";

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
 * The replay window of `lifeId` and who played in it (`GET /api/lives/:id/replay`). A death chunk
 * missing from R2 counts as expired, marked or not: a life's row is written only once its chunk
 * is in R2. So does one in another format version: no player can show it any more. Earlier
 * chunks of the window that are gone (or don't continue into the next) just shorten it.
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
  const end = life.endTick ?? range.endTick;
  const chunks = key
    ? [
        ...(await chunksBefore(
          bucket,
          key,
          range.startTick,
          replayWindowStart(life.startTick, end),
        )),
        bytes,
      ]
    : [bytes];
  const first = chunks[0] ? replayChunkInfo(chunks[0]).startTick : range.startTick;
  return {
    status: "ok",
    replay: {
      chunks: chunks.map((c) => Buffer.from(c).toString("base64")),
      participants: await getParticipants(db, life.room, first, range.endTick),
    },
  };
}

/**
 * The chunks of the room of `deathKey` that come before the one starting at `deathStart` and
 * cover ticks from `from` on, oldest first: the rest of a replay window. One R2 list call (keys
 * sort by start tick) and a get per chunk, at most `REPLAY_WINDOW_MAX_CHUNKS - 1` of them. Stops
 * at the first one missing, unreadable or not ending where the next begins, so what comes back
 * always plays straight into the death chunk.
 */
export async function chunksBefore(
  bucket: R2Bucket,
  deathKey: string,
  deathStart: number,
  from: number,
): Promise<Uint8Array[]> {
  const death = parseChunkKey(deathKey);
  if (!death || from >= deathStart) return [];
  // Chunks are 1200 ticks; start listing a chunk's length before `from` to catch the one
  // holding it. Keys are zero-padded, so they list in tick order.
  const listed = await bucket.list({
    prefix: death.room,
    startAfter: `${death.room}${String(Math.max(0, from - CHUNK_TICKS - 1)).padStart(10, "0")}.zsr`,
    limit: REPLAY_WINDOW_MAX_CHUNKS * 2,
  });
  const starts = listed.objects
    .map((o) => ({ key: o.key, tick: parseChunkKey(o.key)?.tick }))
    .filter((c): c is { key: string; tick: number } => c.tick !== undefined && c.tick < deathStart)
    .sort((a, b) => a.tick - b.tick);
  // Drop chunks that end before the window: those followed by another starting at or before it.
  const needed = starts.filter((_, i) => (starts[i + 1]?.tick ?? deathStart) > from);
  const wanted = needed.slice(-(REPLAY_WINDOW_MAX_CHUNKS - 1));
  const bodies = await Promise.all(
    wanted.map(async (c) => {
      const object = await bucket.get(c.key);
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    }),
  );
  // Keep the run that leads into the death chunk without a gap.
  const out: Uint8Array[] = [];
  let next = deathStart;
  for (let i = bodies.length - 1; i >= 0; i--) {
    const body = bodies[i];
    if (!body || replayChunkVersion(body) !== REPLAY_VERSION) break;
    let info: { startTick: number; endTick: number };
    try {
      info = replayChunkInfo(body);
    } catch {
      break;
    }
    if (info.endTick !== next) break;
    out.unshift(body);
    next = info.startTick;
  }
  return out;
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
