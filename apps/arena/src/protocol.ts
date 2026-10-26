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
  /** R2 key (REPLAYS) of the replay chunk the life starts in; later chunks follow by tick. */
  replayKey: string;
  /** Wall-clock ms. */
  startedAt: number;
  endedAt: number;
}

/** A version banned by a room's CPU backstop. */
export interface BanRecord {
  versionId: string;
  author: string;
  lifeId: string;
  roomId: string;
  /** Room tick of the batch that blew the DO CPU limit. */
  tick: number;
  reason: "cpu";
  message: string;
  at: number;
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
  /** Batches that died (CPU limit, eviction) and were replayed by the backstop. */
  incidents: { tick: number; outcome: "banned" | "inconclusive"; versionId: string | null }[];
  bans: string[];
}

/** Calls the matchmaker accepts from rooms. */
export interface MatchmakerRpc {
  /** The next life for `roomId` whose author is not in `excludeAuthors`, or null. */
  nextLife(request: { roomId: string; excludeAuthors: string[] }): Promise<LifeTicket | null>;
  /** A deployed version's life ended (already written to D1). */
  lifeEnded(result: LifeResult): Promise<void>;
  /** The room's backstop banned a version (already recorded in D1). */
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
