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
  deathCause: DeathCause;
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

/** A version banned by a room's CPU backstop (after `STRIKES_TO_BAN` strikes, see `backstop.ts`). */
export interface BanRecord {
  versionId: string;
  author: string;
  /** The life of the last strike. */
  lifeId: string;
  roomId: string;
  /** Room tick of the last strike. */
  tick: number;
  /**
   * `cpu`: running this bot alone blew the DO CPU limit, reproducibly; `slow`: run alone, its
   * ticks were measured far over budget (each confirmed by a trial, see `backstop.ts`).
   */
  reason: "cpu" | "slow";
  message: string;
  at: number;
}

/**
 * - `restart`: a batch died too quickly to be the CPU limit (deploy, eviction); nobody blamed.
 * - `overrun`: a batch died after long enough to be the CPU limit; the room is watched.
 * - `suspect`: in watch mode, one bot's call (or its measured slowness) could explain it; that
 *   bot goes on trial alone. No strike yet.
 * - `cleared`: the suspect's trial completed without reproducing it. No strike.
 * - `inconclusive`: the trial couldn't reproduce or rule it out (restarts, suspect gone). No strike.
 * - `culprit`: the trial reproduced the CPU overrun with only the suspect running: a strike.
 * - `slow`: the trial measured the suspect far over budget on its own: a strike.
 * - `banned`: a strike that was the version's last allowed one.
 */
export type IncidentOutcome =
  | "restart"
  | "overrun"
  | "suspect"
  | "cleared"
  | "inconclusive"
  | "culprit"
  | "slow"
  | "banned";

/** Tunables of one room. Defaults suit production; tests shrink them. */
export interface RoomLimits {
  /** The DO CPU limit the room is deployed with (`limits.cpu_ms`). Default 30 000. */
  cpuLimitMs?: number;
  /** Fixed ticks per batch instead of worst-case sizing (0 = size it). Default 0. */
  batchTicks?: number;
  /** Watch mode: a bot call measured over this is a slow tick. Default 250. */
  slowTickMs?: number;
  /** Stop simulating while the outbox holds more items than this. Default 500. */
  maxOutbox?: number;
  /** Ticks per replay chunk. Default `CHUNK_TICKS` (1200, two minutes). */
  chunkTicks?: number;
  /** Trials: random wait after each of the suspect's calls, up to this. Default 100. */
  trialGapMs?: number;
}

export type JoinResult =
  | { ok: true }
  | { ok: false; reason: "closed" | "duplicate-life" | "author-present" | "banned" | "full" };

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
  strikes: { versionId: string; lifeId: string; kind: "cpu" | "slow"; tick: number }[];
  bans: string[];
  /** Watch mode (isolated running) is on. */
  watching: boolean;
  /** A suspect waiting for its trial (batches wait too). */
  trial: { lifeId: string; kind: "cpu" | "slow" } | null;
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
  /** A deployed version's life ended (already written to D1; may be minutes after the death,
   * since rows wait for their replay chunk). At least once. */
  lifeEnded(result: LifeResult): Promise<void>;
  /** The room's backstop banned a version (already recorded in D1). At least once. */
  versionBanned(ban: BanRecord): Promise<void>;
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
