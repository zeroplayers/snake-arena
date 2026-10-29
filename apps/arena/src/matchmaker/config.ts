/**
 * The matchmaker's tunables (SPEC §4). Defaults suit production; `MatchmakerDO.configure` (tests,
 * tools) overrides them in the object's storage.
 */
import { ARENA_CONTROL_POLL_MS, ARENA_LIMITS } from "@zerosnake/web/shared";
import { DEFAULT_MAX_SNAKES } from "../limits.ts";
import type { RoomStartOptions } from "../protocol.ts";

export interface MatchmakerConfig {
  /**
   * Lives waiting in the queue beyond which new rooms open ("New rooms open when the queue
   * exceeds a threshold"): enough rooms to bring it back down to this. Below it, waiting lives
   * go to the open rooms: into slots their snakes leave, and into slots house bots hold, which
   * make way for them (rooms count only deployed bots' lives toward `maxSnakes`). With none
   * open, any waiting life opens a room.
   */
  openThreshold: number;
  /**
   * Rooms' `maxSnakes`: lives of deployed versions a room takes. House bots fill the slots they
   * don't use, so a room always runs this many snakes.
   */
  maxSnakes: number;
  /** Lives a bot (all its versions) starts per UTC day. */
  livesPerBotPerDay: number;
  /** Most rooms open at once. */
  maxRooms: number;
  /** Most rooms one alarm opens (each costs a `start` and up to `maxSnakes` joins). */
  roomsPerAlarm: number;
  /** Alarm period: how quickly `change_seq` changes reach the queue and the rooms. */
  pollMs: number;
  /** How often to re-read every playable version from D1 (deleted rows have no `change_seq`). */
  reconcileMs: number;
  /** How often to compare a room's lives with the ledger (`status()`), per room. */
  roomCheckMs: number;
  /**
   * A life its room stopped holding this long ago (by the room checks, `status()`; or issued this
   * long ago and never seen held) that nobody reported is lost: the bot gets its next life (the
   * lost one still counts toward its quota: it may have run). Counted from when the room last
   * held it, not from when it was issued: a life lasts until the snake dies (up to 24 hours of
   * game time, more in wall time), so time since issue says nothing. A room counts as holding a
   * life only while its tick moves: one stuck on it (outbox full, alarm crash loop) stops
   * refreshing it, so its bots are freed `lostAfterMs` later. Once a life ends, its report
   * waits in the room's outbox for its replay chunk (at most two minutes of game time, two
   * minutes of wall time in a real-time room) and for retries; this is well past both.
   */
  lostAfterMs: number;
  /**
   * A life its room still holds this long after it was issued is retired (`leave`): longer than
   * a capped life can take (24 hours of game time, 24 hours of wall time even in a room that ran
   * in real time throughout), so its room is assumed stuck on it.
   */
  maxLifeMs: number;
  /** How often to re-read the kill switch (`arena_control`) when nobody calls. */
  arenaControlPollMs: number;
  /** Most often the alarm writes the `arena.gauge` metric. */
  gaugeMs: number;
  /** No alarms: work runs only through `tick()` (tests, tools). */
  manual: boolean;
  /** Extra options for every room the matchmaker starts (tests: manual rooms, small limits). */
  room: Pick<RoomStartOptions, "mode" | "manual" | "limits">;
}

export const DEFAULT_MATCHMAKER_CONFIG: MatchmakerConfig = {
  openThreshold: 10,
  maxSnakes: DEFAULT_MAX_SNAKES,
  livesPerBotPerDay: ARENA_LIMITS.livesPerBotPerDay,
  maxRooms: 200,
  roomsPerAlarm: 4,
  pollMs: 3_000,
  reconcileMs: 10 * 60_000,
  roomCheckMs: 60_000,
  lostAfterMs: 30 * 60_000,
  maxLifeMs: 48 * 60 * 60_000,
  arenaControlPollMs: ARENA_CONTROL_POLL_MS,
  gaugeMs: 60_000,
  manual: false,
  room: {},
};

/** Rows read per page of the `change_seq` poll and of the full reconcile. */
export const PAGE_ROWS = 500;
/** Most `RoomRpc.leave` calls per alarm. */
export const LEAVES_PER_ALARM = 50;
/**
 * A `leave` the room couldn't act on yet (the ticket hadn't reached it, or its batch was spawning
 * it) or that failed is asked again after this, doubling up to `LEAVE_RETRY_MAX_MS`, while the
 * life is in flight.
 */
export const LEAVE_RETRY_MS = 1_000;
export const LEAVE_RETRY_MAX_MS = 60_000;
/** Most rooms whose `status()` one alarm checks. */
export const ROOM_CHECKS_PER_ALARM = 4;
/** Most old ledger rows one alarm deletes. */
export const PRUNE_ROWS = 500;
/** Candidates `nextLife` tries before giving up for now (each may turn out not playable). */
export const NEXT_LIFE_ATTEMPTS = 3;
/** Bundles kept in memory (each up to 256 KiB). */
export const SOURCE_CACHE_SIZE = 64;

export const DAY_MS = 86_400_000;

/** UTC day number of `ms` (the quota's day). */
export function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

/**
 * Rooms to open now: enough to bring `waiting` lives down to the threshold, at
 * `maxSnakes` per room; one if lives wait and no room is open; within the per-alarm and total
 * caps.
 */
export function roomsToOpen(waiting: number, openRooms: number, c: MatchmakerConfig): number {
  let n = waiting > c.openThreshold ? Math.ceil((waiting - c.openThreshold) / c.maxSnakes) : 0;
  if (n === 0 && waiting > 0 && openRooms === 0) n = 1;
  return Math.max(0, Math.min(n, c.roomsPerAlarm, c.maxRooms - openRooms));
}
