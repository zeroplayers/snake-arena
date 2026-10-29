/**
 * Replay retention (`src/shared/replay.ts`, #78): the Cron Trigger every 30 minutes deletes the
 * replay chunks in R2 `REPLAYS` that are older than `REPLAY_RETENTION_DAYS` and that no pinned
 * life needs. Built like the trace sweep (apps/arena `src/traces.ts`):
 *
 * - The pinned lives are settled first (`loadPinnedLives`). If that fails, or the pinned set
 *   shrank to less than half of the last run's, the run deletes nothing.
 * - Pins are sticky: a life stays pinned `REPLAY_RETENTION_DAYS` after the last run that picked
 *   it (`lives.replay_pinned_at`), so a bot that leaves the top 20 for a while (a redeploy, a
 *   rollback, a quarantine, rank jitter at 20/21) keeps its best replays.
 * - Keys are `<roomId>/<start tick, 10 digits>.zsr`, so a room's chunks list oldest first. Each
 *   run lists the rooms (`delimiter: "/"`), then each room's chunks from its first, and stops at
 *   the room's first chunk young enough to keep: a room costs one list call once its old chunks
 *   are gone (the pinned ones stay at the front).
 * - Bounded: `SWEEP_LISTS` list calls, `SWEEP_DELETES` deletions and `SWEEP_TIME_MS` per run,
 *   rooms taken from a random one on, so a run that stops early leaves different rooms for the
 *   next. Accelerated rooms write a chunk every ~15 s (~5,800 a day), so one run keeps up with a
 *   few hundred rooms. A sweep that falls behind ends every run with `outcome: "more"`: that's
 *   what to alert on (apps/web README, "Alerts"). `oldestDeletedHours` is only informational: a
 *   chunk whose pin lapsed is deleted 2 days after its last pin, however old it is.
 * - Idempotent: before deleting a batch of chunks it marks the lives that died in them
 *   (`lives.replay_expired_at`), so the site stops linking to them; a run that fails between the
 *   two does both again next time.
 *
 * A chunk's age is its R2 upload time. Pinned lives are picked among those whose replay is still
 * there: a bot that enters the top 20 has its best lives of the last two days pinned, not
 * older ones already deleted.
 */

import { log, type MetricsDataset, writeMetric } from "@zerosnake/observability";
import { MAX_LIFE_SCORE } from "@zerosnake/rating";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { createDb, type Db } from "../db";
import { leaderboardQuery } from "../db/queries";
import { bots, lives, users, versions } from "../db/schema";
import {
  parseChunkKey,
  REPLAY_PINNED_LIVES_PER_BOT,
  REPLAY_PINNED_TOP_BOTS,
  REPLAY_PINNED_TOP_LIVES,
  REPLAY_RETENTION_DAYS,
  replayWindowStart,
} from "../shared/replay";

/** `triggers.crons` entry that runs the sweep (wrangler.jsonc). */
export const REPLAYS_CRON = "*/30 * * * *";
/** Most R2 list calls (1000 keys each) one sweep makes, rooms included. */
export const SWEEP_LISTS = 300;
/** Most chunks one sweep deletes (1000 per R2 delete call and per D1 batch). */
export const SWEEP_DELETES = 50_000;
/** Wall time after which a sweep stops listing (it still deletes what it found). */
export const SWEEP_TIME_MS = 60_000;
/** A run whose fresh pinned set is smaller than this share of the last run's deletes nothing. */
export const PIN_SHRINK_GUARD = 0.5;
/** Keys per R2 delete call and per D1 batch of `UPDATE`s. */
const FLUSH_KEYS = 1000;
/** Keys per `UPDATE … IN (…)`: D1 binds at most 100 parameters per statement. */
const MARK_KEYS = 90;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export interface ReplaySweepEnv {
  DB: D1Database;
  REPLAYS: R2Bucket;
  METRICS?: MetricsDataset;
}

/** A life whose replay is kept: the chunks of its replay window, up to its death (`replayKey`). */
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
/** Best first; on equal scores the earlier life keeps its place. */
const bestFirst = [desc(lives.score), asc(lives.endedAt), asc(lives.id)];

/**
 * The lives pinned right now (`src/shared/replay.ts`), among those whose replay is still there:
 * - the best of all time by score, leaving out lives of banned authors and bots and scores the
 *   rating job rejects (`MAX_LIFE_SCORE`); archived bots count. Reads `lives_replay_score_idx`
 *   in score order and stops at the limit;
 * - the best of each top leaderboard bot (`leaderboardQuery`), over all its versions: the best
 *   few of each version from `lives_version_replay_score_idx`, merged.
 *
 * The partial indexes hold only lives whose replay is still there (the last two days' and the
 * pinned ones), however long `lives` grows.
 */
export async function selectPinnedLives(db: Db): Promise<PinnedLife[]> {
  const board = await leaderboardQuery(db, { limit: REPLAY_PINNED_TOP_BOTS });
  const results = await db.batch([
    bestLivesQuery(db),
    ...board.map((entry) => botBestLivesQuery(db, entry.botId)),
  ]);
  return uniqueLives(results.flat());
}

/** The best lives of all time (`selectPinnedLives`). */
export function bestLivesQuery(db: Db) {
  return db
    .select(pinColumns)
    .from(lives)
    .innerJoin(versions, eq(versions.id, lives.versionId))
    .innerJoin(bots, eq(bots.id, versions.botId))
    .innerJoin(users, eq(users.id, bots.ownerId))
    .where(
      and(
        hasReplay,
        lte(lives.score, MAX_LIFE_SCORE),
        isNull(users.bannedAt),
        isNull(bots.bannedAt),
      ),
    )
    .orderBy(...bestFirst)
    .limit(REPLAY_PINNED_TOP_LIVES);
}

/**
 * A bot's best lives over all its versions (`selectPinnedLives`): the best few of each version,
 * read in order from `lives_version_replay_score_idx`, then the best of those.
 */
export function botBestLivesQuery(db: Db, botId: string) {
  const best = alias(lives, "best");
  const ofVersion = db
    .select({ id: best.id })
    .from(best)
    .where(
      and(eq(best.versionId, versions.id), isNotNull(best.replayKey), isNull(best.replayExpiredAt)),
    )
    .orderBy(desc(best.score), asc(best.endedAt), asc(best.id))
    .limit(REPLAY_PINNED_LIVES_PER_BOT);
  return db
    .select(pinColumns)
    .from(versions)
    .innerJoin(lives, inArray(lives.id, ofVersion))
    .where(eq(versions.botId, botId))
    .orderBy(...bestFirst)
    .limit(REPLAY_PINNED_LIVES_PER_BOT);
}

function uniqueLives(rows: (Omit<PinnedLife, "replayKey"> & { replayKey: string | null })[]) {
  const pinned = new Map<string, PinnedLife>();
  for (const row of rows) {
    if (row.replayKey !== null) pinned.set(row.id, { ...row, replayKey: row.replayKey });
  }
  return [...pinned.values()];
}

/**
 * The lives a sweep at `now` keeps the replays of: those pinned now (`selectPinnedLives`), which
 * get `replay_pinned_at = now`, and those pinned by any run in the last `REPLAY_RETENTION_DAYS`.
 * Throws `PinnedSetError` if a query fails, or if the fresh set is smaller than
 * `PIN_SHRINK_GUARD` of the last run's (a query that silently returns too little); nothing is
 * marked then.
 */
export async function loadPinnedLives(db: Db, now: number): Promise<PinnedLife[]> {
  try {
    const fresh = await selectPinnedLives(db);
    const [last] = await db.all<{ n: number }>(sql`
      SELECT count(*) AS n FROM ${lives}
      WHERE replay_expired_at IS NULL AND replay_pinned_at = (
        SELECT max(replay_pinned_at) FROM ${lives}
        WHERE replay_pinned_at IS NOT NULL AND replay_expired_at IS NULL
      )`);
    const previous = last?.n ?? 0;
    if (fresh.length < previous * PIN_SHRINK_GUARD) {
      throw new Error(`the pinned set shrank from ${previous} to ${fresh.length} lives`);
    }
    const marks = [];
    for (let i = 0; i < fresh.length; i += MARK_KEYS) {
      const ids = fresh.slice(i, i + MARK_KEYS).map((life) => life.id);
      marks.push(
        db
          .update(lives)
          .set({ replayPinnedAt: new Date(now) })
          .where(inArray(lives.id, ids)),
      );
    }
    const [head, ...rest] = marks;
    if (head) await db.batch([head, ...rest]);
    const sticky = await db
      .select(pinColumns)
      .from(lives)
      .where(
        and(
          gte(lives.replayPinnedAt, new Date(now - REPLAY_RETENTION_DAYS * DAY_MS)),
          isNull(lives.replayExpiredAt),
        ),
      );
    return uniqueLives([...fresh, ...sticky]);
  } catch (error) {
    throw new PinnedSetError(error);
  }
}

export { parseChunkKey };

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
    // Only the replay window (the last 10 minutes before the end), not a whole 24-hour life.
    const end = life.endTick ?? death.tick;
    ranges.push({ from: replayWindowStart(life.startTick, end), to: death.tick });
    pins.rooms.set(death.room, ranges);
  }
  return pins;
}

/**
 * Whether a pinned life needs the chunk at `key`. `next` is the start tick of the room's next
 * chunk, `undefined` when unknown (or there's none), which keeps every chunk a pinned life could
 * need. A chunk plays from its start tick up to the next chunk's (each chunk opens with a world
 * snapshot, so it needs no earlier one), and a life needs the chunks of its replay window: from
 * the one holding `replayWindowStart` (its birth, or 10 minutes before its end) to the one it
 * died in.
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
    super("replay sweep: couldn't settle the pinned lives", { cause });
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
  /** Lives pinned this run, sticky ones included. */
  pinnedLives: number;
  /** Lives marked `replay_expired_at`. */
  expiredLives: number;
  rooms: number;
  roomsSwept: number;
  lists: number;
  /**
   * Age of the oldest chunk deleted, in hours; 0 if none. Informational: past the retention for
   * chunks whose pin lapsed as well as when the sweep falls behind.
   */
  oldestDeletedHours: number;
}

export interface ReplaySweepOptions {
  /** Picks the first room (default `Math.random`). */
  random?: () => number;
  lists?: number;
  deletes?: number;
  timeMs?: number;
  /** Keys per R2 delete call and D1 batch (default 1000). */
  flushKeys?: number;
}

export function emptySweep(): ReplaySweep {
  return {
    outcome: "done",
    deleted: 0,
    pinnedChunks: 0,
    pinnedLives: 0,
    expiredLives: 0,
    rooms: 0,
    roomsSwept: 0,
    lists: 0,
    oldestDeletedHours: 0,
  };
}

/**
 * One sweep (see the top of this file). Throws `PinnedSetError` before touching R2. `stats` is
 * filled as it goes, so a run that fails halfway still reports what it deleted.
 */
export async function sweepReplays(
  env: Pick<ReplaySweepEnv, "DB" | "REPLAYS">,
  now: number,
  {
    random = Math.random,
    lists: maxLists = SWEEP_LISTS,
    deletes: maxDeletes = SWEEP_DELETES,
    timeMs = SWEEP_TIME_MS,
    flushKeys = FLUSH_KEYS,
  }: ReplaySweepOptions = {},
  stats: ReplaySweep = emptySweep(),
): Promise<ReplaySweep> {
  const db = createDb(env.DB);
  const pinned = await loadPinnedLives(db, now);
  stats.pinnedLives = pinned.length;
  const pins = pinsOf(pinned);
  const cutoff = now - REPLAY_RETENTION_DAYS * DAY_MS;
  const deadline = Date.now() + timeMs;
  const bucket = env.REPLAYS;
  const doomed: { key: string; uploaded: number }[] = [];
  const budgetLeft = () =>
    stats.lists < maxLists && Date.now() < deadline && stats.deleted + doomed.length < maxDeletes;

  const flush = async (all: boolean) => {
    while (doomed.length >= (all ? 1 : flushKeys)) {
      const batch = doomed.splice(0, flushKeys);
      const keys = batch.map((chunk) => chunk.key);
      stats.expiredLives += await markExpired(db, keys, now);
      await bucket.delete(keys);
      stats.deleted += keys.length;
      const oldest = Math.min(...batch.map((chunk) => chunk.uploaded));
      stats.oldestDeletedHours = Math.max(stats.oldestDeletedHours, (now - oldest) / HOUR_MS);
    }
  };

  const rooms: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ delimiter: "/", limit: 1000, ...(cursor && { cursor }) });
    stats.lists++;
    rooms.push(...page.delimitedPrefixes);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && budgetLeft());
  stats.rooms = rooms.length;

  // Set when the budget ran out before every room was looked at to the end.
  let more = cursor !== undefined;
  const first = Math.floor(random() * rooms.length);
  for (let i = 0; i < rooms.length; i++) {
    if (!budgetLeft()) {
      more = true;
      break;
    }
    const room = rooms[(first + i) % rooms.length] as string;
    // An old chunk, decided once the next chunk's start tick is known.
    let old: { key: string; uploaded: number } | undefined;
    const decide = (next: number | undefined) => {
      if (old === undefined) return;
      if (isPinned(pins, old.key, next)) stats.pinnedChunks++;
      else doomed.push(old);
      old = undefined;
    };
    let roomCursor: string | undefined;
    roomLoop: do {
      if (!budgetLeft()) {
        more = true;
        break;
      }
      const page = await bucket.list({
        prefix: room,
        limit: 1000,
        ...(roomCursor && { cursor: roomCursor }),
      });
      stats.lists++;
      for (const object of page.objects) {
        // Only a chunk of this room tells where the previous one ends (not a nested key).
        const chunk = parseChunkKey(object.key);
        decide(chunk?.room === room ? chunk.tick : undefined);
        const uploaded = object.uploaded.getTime();
        if (uploaded >= cutoff) break roomLoop;
        if (stats.deleted + doomed.length >= maxDeletes) {
          more = true;
          break roomLoop;
        }
        old = { key: object.key, uploaded };
      }
      roomCursor = page.truncated ? page.cursor : undefined;
    } while (roomCursor);
    // The room's last chunk, or the last one this run got to: kept if a pinned life might need it.
    if (stats.deleted + doomed.length < maxDeletes) decide(undefined);
    stats.roomsSwept++;
    await flush(false);
  }
  await flush(true);

  stats.outcome = more ? "more" : "done";
  return stats;
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
export async function runReplaySweep(
  env: ReplaySweepEnv,
  now: Date,
  options: ReplaySweepOptions = {},
) {
  const started = Date.now();
  const stats = emptySweep();
  let outcome: "done" | "more" | "no_pins" | "failed";
  try {
    await sweepReplays(env, now.getTime(), options, stats);
    outcome = stats.outcome;
  } catch (error) {
    outcome = error instanceof PinnedSetError ? "no_pins" : "failed";
    log("error", "replays.sweep_failed", { ...stats, outcome, error });
  }
  const durationMs = Date.now() - started;
  if (outcome === "done" || outcome === "more")
    log("info", "replays.swept", { ...stats, durationMs });
  writeMetric(env.METRICS, "replays.swept", {
    outcome,
    deleted: stats.deleted,
    pinnedChunks: stats.pinnedChunks,
    pinnedLives: stats.pinnedLives,
    expiredLives: stats.expiredLives,
    rooms: stats.rooms,
    roomsSwept: stats.roomsSwept,
    lists: stats.lists,
    durationMs,
    oldestDeletedHours: stats.oldestDeletedHours,
  });
  return outcome === "done" || outcome === "more" ? stats : null;
}
