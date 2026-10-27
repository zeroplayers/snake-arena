/**
 * The matchmaker's tunables (SPEC §4). Defaults suit production; `MatchmakerDO.configure` (tests,
 * tools) overrides them in the object's storage.
 */
import { ARENA_CONTROL_POLL_MS, ARENA_LIMITS } from "@zerosnake/web/shared";
import { DEFAULT_MAX_SNAKES, DEFAULT_MIN_AUTHORS } from "../limits.ts";
import type { RoomStartOptions } from "../protocol.ts";

export interface MatchmakerConfig {
  /**
   * Lives waiting in the queue beyond which new rooms open ("New rooms open when the queue
   * exceeds a threshold"): enough rooms to bring it back down to this. Below it, waiting lives
   * go to rooms as their snakes die. With none open, any waiting life opens a room.
   */
  openThreshold: number;
  /** Rooms' `maxSnakes` and `minAuthors` (house bots fill up to it). */
  maxSnakes: number;
  minAuthors: number;
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
   * A life issued this long ago that its room doesn't hold and nobody reported is lost: the bot
   * gets its next life (the lost one still counts toward its quota: it may have run). Well past
   * a life's longest run (`lifeCap`, 10 min in real time) plus its replay chunk's wait.
   */
  lostAfterMs: number;
  /** How often to re-read the kill switch (`arena_control`) when nobody calls. */
  arenaControlPollMs: number;
  /** No alarms: work runs only through `tick()` (tests, tools). */
  manual: boolean;
  /** Extra options for every room the matchmaker starts (tests: manual rooms, small limits). */
  room: Pick<RoomStartOptions, "mode" | "manual" | "limits">;
}

export const DEFAULT_MATCHMAKER_CONFIG: MatchmakerConfig = {
  openThreshold: 10,
  maxSnakes: DEFAULT_MAX_SNAKES,
  minAuthors: DEFAULT_MIN_AUTHORS,
  livesPerBotPerDay: ARENA_LIMITS.livesPerBotPerDay,
  maxRooms: 200,
  roomsPerAlarm: 4,
  pollMs: 3_000,
  reconcileMs: 10 * 60_000,
  roomCheckMs: 60_000,
  lostAfterMs: 30 * 60_000,
  arenaControlPollMs: ARENA_CONTROL_POLL_MS,
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
