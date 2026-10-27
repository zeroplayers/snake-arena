/**
 * Replay retention (`src/shared/replay.ts`, #78): the Cron Trigger every 30 minutes deletes the
 * replay chunks in R2 `REPLAYS` that are older than `REPLAY_RETENTION_DAYS` and that no pinned
 * life needs. Built like the trace sweep (apps/arena `src/traces.ts`):
 *
 * - The pinned lives are read first. If that fails, the run deletes nothing.
 * - Keys are `<roomId>/<start tick, 10 digits>.zsr`, so a room's chunks list oldest first. Each
 *   run lists the rooms (`delimiter: "/"`), then each room's chunks from its first, and stops at
 *   the room's first chunk young enough to keep: a room costs one list call once its old chunks
 *   are gone (the pinned ones stay at the front).
 * - Bounded: at most `SWEEP_LISTS` list calls and `SWEEP_DELETES` deletions per run, rooms taken
 *   from a random one on, so a run that stops early leaves different rooms for the next.
 * - Idempotent: before deleting a batch of chunks it marks the lives that died in them
 *   (`lives.replay_expired_at`), so the site stops linking to them; a run that fails between the
 *   two does both again next time.
 *
 * A chunk's age is its R2 upload time. Pinned lives are picked among those whose replay is still
 * there: a bot that enters the top 20 has its best lives of the last two days pinned, not
 * older ones already deleted.
 */
import { log, type MetricsDataset, writeMetric } from "@zerosnake/observability";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { createDb, type Db } from "../db";
import { leaderboardQuery } from "../db/queries";
import { lives, versions } from "../db/schema";
import {
  REPLAY_PINNED_LIVES_PER_BOT,
  REPLAY_PINNED_TOP_BOTS,
  REPLAY_PINNED_TOP_LIVES,
  REPLAY_RETENTION_DAYS,
} from "../shared/replay";

/** `triggers.crons` entry that runs the sweep (wrangler.jsonc). */
export const REPLAYS_CRON = "*/30 * * * *";
/** Most R2 list calls (1000 keys each) one sweep makes, rooms included. */
export const SWEEP_LISTS = 50;
/** Most chunks one sweep deletes. */
export const SWEEP_DELETES = 5000;
/** Keys per `UPDATE … IN (…)`: D1 binds at most 100 parameters per statement. */
const MARK_KEYS = 90;
const DAY_MS = 86_400_000;

export interface ReplaySweepEnv {
  DB: D1Database;
  REPLAYS: R2Bucket;
  METRICS?: MetricsDataset;
}

/** A life whose replay is kept: every chunk from its birth to its death (`replayKey`). */
export interface PinnedLife {
  id: string;
  startTick: number;
  endTick: number | null;
  replayKey: string;
}

const hasReplay = and(isNotNull(lives.replayKey), isNull(lives.replayExpiredAt));
const pinColumns = {
  id: lives.id,
  startTick: lives.startTick,
  endTick: lives.endTick,
  replayKey: lives.replayKey,
};

/**
 * The pinned lives (`src/shared/replay.ts`): the best of all time, and the best of each top
 * leaderboard bot over all its versions, by score. Both read `lives_replay_score_idx` /
 * `lives_version_replay_score_idx`, partial indexes that hold only lives whose replay is still
 * there (the last two days' and the pinned ones). Throws if a query fails.
 */
export async function loadPinnedLives(db: Db): Promise<PinnedLife[]> {
  const board = await leaderboardQuery(db, { limit: REPLAY_PINNED_TOP_BOTS });
  const best = (botId?: string) =>
    db
      .select(pinColumns)
      .from(lives)
      .innerJoin(versions, eq(versions.id, lives.versionId))
      .where(botId === undefined ? hasReplay : and(eq(versions.botId, botId), hasReplay))
      .orderBy(desc(lives.score), lives.id)
      .limit(botId === undefined ? REPLAY_PINNED_TOP_LIVES : REPLAY_PINNED_LIVES_PER_BOT);
  const results = await db.batch([best(), ...board.map((entry) => best(entry.botId))]);
  const pinned = new Map<string, PinnedLife>();
  for (const row of results.flat()) {
    if (row.replayKey !== null) pinned.set(row.id, { ...row, replayKey: row.replayKey });
  }
  return [...pinned.values()];
}

/** A chunk key's room prefix (`<roomId>/`) and start tick, or null for any other key. */
export function parseChunkKey(key: string): { room: string; tick: number } | null {
  const match = /^(.+\/)(\d+)\.zsr$/.exec(key);
  if (!match) return null;
  return { room: match[1] as string, tick: Number(match[2]) };
}

/** Pinned lives as tick ranges per room: chunks starting from `from`'s chunk up to `to`. */
export interface Pins {
  /** Every pinned life's death chunk, whatever its key looks like. */
  keys: Set<string>;
  rooms: Map<string, { from: number; to: number }[]>;
}

export function pinsOf(pinned: PinnedLife[]): Pins {
  const pins: Pins = { keys: new Set(), rooms: new Map() };
  for (const life of pinned) {
    pins.keys.add(life.replayKey);
    const death = parseChunkKey(life.replayKey);
    if (!death) continue;
    const ranges = pins.rooms.get(death.room) ?? [];
    ranges.push({ from: life.startTick, to: death.tick });
    pins.rooms.set(death.room, ranges);
  }
  return pins;
}

/**
 * Whether a pinned life needs the chunk at `key`. `next` is the start tick of the room's next
 * chunk, `undefined` when unknown (or there's none), which keeps every chunk a pinned life could
 * need. A chunk plays from its start tick up to the next chunk's (each chunk opens with a world
 * snapshot, so it needs no earlier one), and a life needs every chunk from the one it was born in
 * to the one it died in.
 */
export function isPinned(pins: Pins, key: string, next: number | undefined): boolean {
  if (pins.keys.has(key)) return true;
  const chunk = parseChunkKey(key);
  if (!chunk) return false;
  return (pins.rooms.get(chunk.room) ?? []).some(
    (life) => chunk.tick <= life.to && (next === undefined || next >= life.from),
  );
}

/** The pinned lives couldn't be read: nothing was deleted. */
export class PinnedSetError extends Error {
  constructor(cause: unknown) {
    super("replay sweep: couldn't read the pinned lives", { cause });
    this.name = "PinnedSetError";
  }
}

export interface ReplaySweep {
  /** `done`: every room looked at; `more`: stopped at the per-run budget. */
  outcome: "done" | "more";
  /** Chunks deleted. */
  deleted: number;
  /** Chunks older than the retention kept for a pinned life (in the rooms looked at). */
  pinnedChunks: number;
  pinnedLives: number;
  /** Lives marked `replay_expired_at`. */
  expiredLives: number;
  rooms: number;
  roomsSwept: number;
  lists: number;
}

export interface ReplaySweepOptions {
  /** Picks the first room (default `Math.random`). */
  random?: () => number;
  lists?: number;
  deletes?: number;
}

/** One sweep (see the top of this file). Throws `PinnedSetError` before touching R2. */
export async function sweepReplays(
  env: Pick<ReplaySweepEnv, "DB" | "REPLAYS">,
  now: number,
  {
    random = Math.random,
    lists: maxLists = SWEEP_LISTS,
    deletes = SWEEP_DELETES,
  }: ReplaySweepOptions = {},
): Promise<ReplaySweep> {
  const db = createDb(env.DB);
  let pinned: PinnedLife[];
  try {
    pinned = await loadPinnedLives(db);
  } catch (error) {
    throw new PinnedSetError(error);
  }
  const pins = pinsOf(pinned);
  const cutoff = now - REPLAY_RETENTION_DAYS * DAY_MS;
  const bucket = env.REPLAYS;
  let lists = 0;

  const rooms: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ delimiter: "/", limit: 1000, ...(cursor && { cursor }) });
    lists++;
    rooms.push(...page.delimitedPrefixes);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && lists < maxLists);

  const doomed: string[] = [];
  let pinnedChunks = 0;
  let roomsSwept = 0;
  // Set when the budget ran out before every room was looked at to the end.
  let more = cursor !== undefined;
  const first = Math.floor(random() * rooms.length);
  for (let i = 0; i < rooms.length; i++) {
    if (lists >= maxLists || doomed.length >= deletes) {
      more = true;
      break;
    }
    const room = rooms[(first + i) % rooms.length] as string;
    // An old chunk, decided once the next chunk's start tick is known.
    let old: string | undefined;
    const decide = (next: number | undefined) => {
      if (old === undefined) return;
      if (isPinned(pins, old, next)) pinnedChunks++;
      else doomed.push(old);
      old = undefined;
    };
    let roomCursor: string | undefined;
    roomLoop: do {
      if (lists >= maxLists) {
        more = true;
        break;
      }
      const page = await bucket.list({
        prefix: room,
        limit: 1000,
        ...(roomCursor && { cursor: roomCursor }),
      });
      lists++;
      for (const object of page.objects) {
        decide(parseChunkKey(object.key)?.tick);
        if (object.uploaded.getTime() >= cutoff) break roomLoop;
        if (doomed.length >= deletes) {
          more = true;
          break roomLoop;
        }
        old = object.key;
      }
      roomCursor = page.truncated ? page.cursor : undefined;
    } while (roomCursor);
    // The room's last chunk, or the last one this run got to: kept if a pinned life might need it.
    if (doomed.length < deletes) decide(undefined);
    roomsSwept++;
  }

  let expiredLives = 0;
  for (let i = 0; i < doomed.length; i += 1000) {
    const keys = doomed.slice(i, i + 1000);
    expiredLives += await markExpired(db, keys, now);
    await bucket.delete(keys);
  }

  return {
    outcome: more ? "more" : "done",
    deleted: doomed.length,
    pinnedChunks,
    pinnedLives: pinned.length,
    expiredLives,
    rooms: rooms.length,
    roomsSwept,
    lists,
  };
}

/** Sets `replay_expired_at` on the lives that died in the chunks at `keys`; returns how many. */
async function markExpired(db: Db, keys: string[], now: number): Promise<number> {
  const updates = [];
  for (let i = 0; i < keys.length; i += MARK_KEYS) {
    updates.push(
      db
        .update(lives)
        .set({ replayExpiredAt: new Date(now) })
        .where(
          and(
            isNull(lives.replayExpiredAt),
            inArray(lives.replayKey, keys.slice(i, i + MARK_KEYS)),
          ),
        ),
    );
  }
  const [head, ...rest] = updates;
  if (!head) return 0;
  const results = await db.batch([head, ...rest]);
  return results.reduce((n, r) => n + r.meta.changes, 0);
}

/** The Cron Trigger's job: sweep, log, write the metric. Never throws (a failure is logged). */
export async function runReplaySweep(env: ReplaySweepEnv, now: Date) {
  const started = Date.now();
  try {
    const sweep = await sweepReplays(env, now.getTime());
    const durationMs = Date.now() - started;
    log("info", "replays.swept", { ...sweep, durationMs });
    writeMetric(env.METRICS, "replays.swept", {
      outcome: sweep.outcome,
      deleted: sweep.deleted,
      pinnedChunks: sweep.pinnedChunks,
      pinnedLives: sweep.pinnedLives,
      expiredLives: sweep.expiredLives,
      rooms: sweep.rooms,
      roomsSwept: sweep.roomsSwept,
      lists: sweep.lists,
      durationMs,
    });
    return sweep;
  } catch (error) {
    const outcome = error instanceof PinnedSetError ? "no_pins" : "failed";
    const durationMs = Date.now() - started;
    log("error", "replays.sweep_failed", { outcome, error, durationMs });
    writeMetric(env.METRICS, "replays.swept", {
      outcome,
      deleted: 0,
      pinnedChunks: 0,
      pinnedLives: 0,
      expiredLives: 0,
      rooms: 0,
      roomsSwept: 0,
      lists: 0,
      durationMs,
    });
    return null;
  }
}
