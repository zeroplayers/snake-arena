import type { Action, DeathCause } from "@zerosnake/engine";
import type { RenderFrame } from "@zerosnake/renderer";

/**
 * Where the viewer gets ticks from. The viewer never simulates or decodes anything itself: it
 * asks the source for ticks up to the playhead (`request`) and reads back whatever is ready
 * (`snapshot`). That covers:
 *
 * - a live engine running in the page (`LiveEngineSource`): `request` simulates synchronously;
 * - a replay (#9): `request` re-simulates from seed + actions, possibly in a worker, and
 *   `lastTick` catches up when it's done; `endTick` is the end of the recording;
 * - a broadcast of a room (`BroadcastSource`): `request` is a no-op and `lastTick` grows as
 *   messages arrive.
 *
 * Ticks in `[firstTick, lastTick]` must stay readable; older ones may be evicted.
 */
export interface MatchSource {
  readonly info: MatchInfo;
  /** Oldest tick still readable. */
  readonly firstTick: number;
  /** Newest tick readable now. */
  readonly lastTick: number;
  /** Last tick of a finished recording; `undefined` while the match can still go on. */
  readonly endTick: number | undefined;
  /** Asks for ticks up to `tick` to become readable. May finish synchronously or later. */
  request(tick: number): void;
  /** The tick, if it is in `[firstTick, lastTick]`. */
  snapshot(tick: number): TickSnapshot | undefined;
  /**
   * Every life the source knows about so far, oldest first. A replay may know deaths that
   * lie past `lastTick`.
   */
  lives(): readonly LifeInfo[];
  life(id: string): LifeInfo | undefined;
  /**
   * What a life's bot did on a tick, without building the whole snapshot. Optional: the log
   * panel reads many ticks back and uses this when present, `snapshot` otherwise.
   */
  trace?(id: string, tick: number): BotTrace | undefined;
  dispose?(): void;
}

export interface MatchInfo {
  /** Simulation ticks per second at 1× speed. */
  readonly tps: number;
  /** Half the side of the square arena. */
  readonly arenaHalfSize: number;
  /** How far a bot sees from its head; drawn around the selected snake. */
  readonly visionRadius: number;
  /** Shown in the viewer's header. */
  readonly title?: string;
  /**
   * A live broadcast that arrives in bursts: ticks to watch it behind its newest one
   * (`followLive`). Undefined for sources that are never ahead of the playhead.
   */
  readonly liveDelay?: number;
}

/** One tick: what to draw plus what the side panel shows. Immutable once returned. */
export interface TickSnapshot {
  readonly tick: number;
  readonly frame: RenderFrame;
  /** Living snakes, in the same order as `frame.snakes`. */
  readonly snakes: readonly SnakeTick[];
  /** Lives that ended on this tick (they are no longer in `snakes`). */
  readonly deaths: readonly string[];
}

/** One bot call: what it returned after seeing a tick (applied on the way to the next one). */
export interface BotTrace {
  /** `undefined` when the source doesn't know, e.g. the newest live tick before the bot ran. */
  readonly action?: Action;
  /** `log()` lines from that call. */
  readonly logs?: readonly string[];
  /** Whether `logs` hit the per-tick byte limit. */
  readonly logTruncated?: boolean;
  /** QuickJS operations used by that call, once the sandbox reports them. */
  readonly ops?: number;
}

/** A living snake on one tick, with its bot's call on that tick. */
export interface SnakeTick extends BotTrace {
  /** Life id; the same as the `RenderSnake` id. */
  readonly id: string;
  readonly score: number;
  /** Engine mass, the SDK's `self.length`. */
  readonly mass: number;
  readonly segments: number;
  readonly kills: number;
  readonly lifeTick: number;
  readonly boosting: boolean;
}

/** One snake life, from spawn to death. */
export interface LifeInfo {
  readonly id: string;
  /** Bot (or bot version) driving this life; lives of the same bot share it. */
  readonly bot: string;
  readonly author: string;
  /** `#rrggbb`, the same as the snake's skin colour. */
  readonly color: string;
  readonly bornTick: number;
  /** Tick on which the life ended (the snake is absent from it). */
  readonly death?: LifeDeath;
}

export interface LifeDeath {
  readonly tick: number;
  readonly cause: DeathCause;
  readonly killerId: string | null;
  readonly score: number;
  readonly mass: number;
  readonly kills: number;
}
