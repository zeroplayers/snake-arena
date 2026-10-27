/**
 * RPC between `MatchmakerDO` and `RoomDO` (SPEC §4). The matchmaker pushes lives into a room with
 * `RoomRpc.join`; the room reports finished lives and pulls replacements through `MatchmakerRpc`.
 * Everything here crosses a Durable Object boundary, so it is plain structured-clone data.
 */
import type { DeathCause } from "@zerosnake/engine";

/** A life the matchmaker hands to a room: one run of one version, from spawn to death. */
export interface LifeTicket {
  /** Unique per life; becomes the snake id and the `lives.id` row. */
  lifeId: string;
  versionId: string;
  /** The bot owner (user id). A room never holds two snakes of one author. */
  author: string;
  /** The version's bundle (ESM, default-exports `defineBot(...)`). */
  source: string;
}

/**
 * How a life ended: the engine's cause, or `evicted` when the room's CPU backstop ended it so the
 * room could make progress (see `room/backstop.ts`). `evicted` is neutral: not a failure of the
 * bot that the room could prove, so ratings must skip it.
 */
export type LifeEndCause = DeathCause | "evicted";

/** A finished life of a deployed version, as written to the `lives` table. */
export interface LifeResult {
  lifeId: string;
  versionId: string;
  author: string;
  roomId: string;
  startTick: number;
  endTick: number;
  score: number;
  /** Highest mass during the life (SPEC's "length"). */
  lengthMax: number;
  kills: number;
  /**
   * `evicted` lives aren't written to D1 (`lives.death_cause` has no such value yet) and must not
   * count toward the version's rating.
   */
  deathCause: LifeEndCause;
  /** The killer's version id, `house:<kind>` for a house bot, null unless `collision`. */
  killer: string | null;
  /**
   * R2 key (REPLAYS) of the replay chunk the life ended in (`<roomId>/<chunk start tick>.zsr`).
   * The object exists before the row is written. Earlier chunks of the room precede it by tick.
   */
  replayKey: string;
  /** Wall-clock ms. */
  startedAt: number;
  endedAt: number;
}

/**
 * A version a room's CPU backstop quarantined: its lives were evicted `EVICTIONS_TO_QUARANTINE`
 * times (see `room/backstop.ts`). Not a ban: the version stays `ready`, with `quarantined_at` and
 * `quarantine_reason` (= `message`) set in D1 (apps/web `src/shared/arena.ts`, "Quarantine"); it
 * just isn't matched any more, in any room, until a person has looked at it.
 */
export interface QuarantineRecord {
  versionId: string;
  author: string;
  /** The life of the last eviction. */
  lifeId: string;
  roomId: string;
  /** Room tick of the last eviction. */
  tick: number;
  evictions: number;
  message: string;
  /** Wall-clock ms; becomes `versions.quarantined_at`. */
  at: number;
}

/**
 * - `restart`: a batch died too quickly to be the CPU limit (deploy, eviction). Counts for nothing.
 * - `overrun`: a batch died after long enough to be the CPU limit, with no bot call to name
 *   (normal mode, or between calls in watch mode). The room is watched.
 * - `suspect`: in watch mode, the batch died inside one bot's call. Counts toward evicting it.
 * - `evicted`: such a kill that evicted the life it named (its `KILLS_TO_EVICT`-th in the kill
 *   window, or the window's `ROOM_KILLS_TO_EVICT`-th kill, which evicts every life it named).
 *   `versionId` is the named life's, unless it's a house bot.
 */
export type IncidentOutcome = "restart" | "overrun" | "suspect" | "evicted";

/** Tunables of one room. Defaults suit production; tests shrink them. */
export interface RoomLimits {
  /** The Worker's CPU limit (`limits.cpu_ms`), when Cloudflare kills a batch. Default 300 000. */
  cpuLimitMs?: number;
  /**
   * The room's own CPU budget per invocation, which batch sizes and watch mode keep to (see
   * `ROOM_CPU_BUDGET_MS`). Default 30 000, or `cpuLimitMs` if that is lower.
   */
  cpuBudgetMs?: number;
  /** Fixed ticks per batch instead of worst-case sizing (0 = size it). Default 0. */
  batchTicks?: number;
  /** Stop simulating while the outbox holds more items than this. Default 500. */
  maxOutbox?: number;
  /** Ticks per replay chunk. Default `CHUNK_TICKS` (1200, two minutes). */
  chunkTicks?: number;
  /** Watch mode: base of the random wait after each bot call (`watchGapMs`). Default 10. */
  watchGapMs?: number;
  /** How often to re-read the arena's kill switch from D1. Default `ARENA_CONTROL_POLL_MS`. */
  arenaControlPollMs?: number;
}

export type JoinResult =
  | { ok: true }
  | { ok: false; reason: "closed" | "duplicate-life" | "author-present" | "quarantined" | "full" };

export type RoomMode = "accelerated" | "realtime";

export interface RoomStartOptions {
  /** Defaults to a random UUID. Replay keys and `lives.room` use it. */
  roomId?: string;
  /** World seed; random when omitted. */
  seed?: number;
  /** Default `accelerated`. */
  mode?: RoomMode;
  /** Most snakes in the room (house bots included). Default 20. */
  maxSnakes?: number;
  /** Fewest distinct authors; house bots fill up to it. Default 5. */
  minAuthors?: number;
  /** Don't schedule alarms; batches run only through `RoomRpc.runBatch` (tests, tools). */
  manual?: boolean;
  limits?: RoomLimits;
}

export interface RoomSnakeStatus {
  lifeId: string;
  versionId: string | null;
  author: string;
  /** House bot kind, or null for a deployed version. */
  house: string | null;
  lifeTick: number;
  mass: number;
}

export interface RoomStatus {
  roomId: string | null;
  state: "new" | "running" | "closed";
  mode: RoomMode;
  tick: number;
  snakes: RoomSnakeStatus[];
  /** Tickets accepted but not spawned yet (they spawn at the start of the next batch). */
  pending: string[];
  /** Ticks of the last completed batch. */
  lastBatchTicks: number;
  /** Lives finished since the room started. */
  livesEnded: number;
  /** Batches that died (CPU limit, restarts) and what the backstop made of them. */
  incidents: { tick: number; outcome: IncidentOutcome; versionId: string | null }[];
  /** Lives the backstop evicted (house bots have no `versionId`). */
  evictions: { versionId: string | null; lifeId: string; tick: number }[];
  /** Versions this room quarantined. */
  quarantined: string[];
  /** The kill window: watched kills that named a life, oldest first (see `backstop.ts`). */
  kills: { lifeId: string; tick: number }[];
  /** An admin stopped the arena (`arena_control.paused`): lives retire, the room closes. */
  arenaPaused: boolean;
  /** Watch mode (each bot call synced, batches stopped early) is on. */
  watching: boolean;
  /** Side effects not delivered yet; `failing` of them failed at least once. */
  outbox: { size: number; failing: number };
  /** Simulation paused until the outbox drains below `maxOutbox`. */
  paused: boolean;
}

/**
 * Calls the matchmaker accepts from rooms. Notifications come from the room's outbox, which
 * retries until a call succeeds: they are **at least once** (a call that timed out after taking
 * effect is repeated), so handle each idempotently (`lifeId`, `versionId`, `roomId` as keys).
 */
export interface MatchmakerRpc {
  /** The next life for `roomId` whose author is not in `excludeAuthors`, or null. */
  nextLife(request: { roomId: string; excludeAuthors: string[] }): Promise<LifeTicket | null>;
  /**
   * A deployed version's life ended (already written to D1, except `evicted` lives; may be
   * minutes after the death, since rows wait for their replay chunk). At least once. Skip
   * `evicted` lives in ratings; counting them per version across rooms (the room only counts its
   * own) and quarantining at `EVICTIONS_TO_QUARANTINE` is the matchmaker's job.
   */
  lifeEnded(result: LifeResult): Promise<void>;
  /**
   * The room's backstop quarantined a version (already set in D1, `versions.quarantined_at`):
   * stop queuing its lives until a person clears it. At least once.
   */
  versionQuarantined(record: QuarantineRecord): Promise<void>;
  /** Only house bots were left and the queue was empty, so the room stopped. */
  roomClosed(roomId: string): Promise<void>;
}

/** Calls a room accepts (from the matchmaker, and from tools and tests). */
export interface RoomRpc {
  start(options?: RoomStartOptions): Promise<RoomStatus>;
  join(ticket: LifeTicket): Promise<JoinResult>;
  /** Retires a life at the next batch (e.g. its version was archived). */
  leave(lifeId: string): Promise<boolean>;
  setMode(mode: RoomMode): Promise<void>;
  status(): Promise<RoomStatus>;
  /** Runs one batch now (what the alarm does). */
  runBatch(): Promise<RoomStatus>;
}
