import type { EngineConfig } from "./config.ts";
import type { RngState } from "./rng.ts";

/**
 * World state. Everything here is plain data (numbers, strings, arrays, objects; no classes,
 * no shared references), so a world can be cloned, JSON-serialised or stored in a Durable
 * Object and resumed bit-identically.
 *
 * Coordinates: the arena is a disc of `config.arenaRadius` centred on (0, 0), y points up.
 * Angles are radians, counter-clockwise from +x.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export type SnakeId = string;

/** What a bot returns each tick. Mirrors `BotAction` in `@zerosnake/sdk`. */
export interface Action {
  /** Steering in [-1, 1]: -1 is full left (counter-clockwise), 1 is full right. Clamped; NaN is 0. */
  turn: number;
  /** Spend mass to move faster. Ignored below `config.boostMinMass`. */
  boost?: boolean;
}

/** Actions for this tick by snake id. A missing entry means `{ turn: 0 }`. */
export type ActionMap = Readonly<Record<SnakeId, Action | undefined>>;

/** Sandbox verdicts for this tick: the snake dies before moving. */
export type Fault = "timeout" | "error";
export type FaultMap = Readonly<Record<SnakeId, Fault | undefined>>;

export type DeathCause = "collision" | "wall" | "timeout" | "error" | "retired";

export interface Snake {
  id: SnakeId;
  /** Owner of the bot; kills are credited to it. */
  author: string;
  /** Seed for this life's bot PRNG, derived from the world seed. */
  seed: number;

  /** Head position; equal to `segments[0]`. */
  head: Vec2;
  /** Heading in radians, normalised to (-π, π]. */
  angle: number;
  /** Distance moved last tick. */
  speed: number;
  boosting: boolean;

  /** Food eaten minus boost and hunger; drives size, segment count and score. SPEC's "length". */
  mass: number;
  /** Segment spacing and body thickness, from mass. */
  size: number;
  /** Body points from head (index 0) to tail, `size` apart along the trail. */
  segments: Vec2[];
  /** Past head positions, oldest first, pruned to what the body covers. Internal. */
  trail: Vec2[];

  /** World tick the life started on. */
  bornTick: number;
  /** Ticks alive so far. */
  lifeTick: number;
  kills: number;
  maxMass: number;
  /** Sum of mass over every tick alive (the "area under the length curve"). */
  massArea: number;
  /** Current life score: massArea × massScoreFactor + kills × killBonus. */
  score: number;
}

export type FoodKind = "ambient" | "boost" | "remains";

export interface Food {
  id: number;
  x: number;
  y: number;
  value: number;
  kind: FoodKind;
}

/** A finished life, emitted on the tick it ended. */
export interface Death {
  id: SnakeId;
  author: string;
  cause: DeathCause;
  /** The snake whose body or head killed this one (`collision` only). */
  killerId: SnakeId | null;
  killerAuthor: string | null;
  tick: number;
  lifeTicks: number;
  mass: number;
  maxMass: number;
  kills: number;
  score: number;
}

export interface World {
  config: EngineConfig;
  /** Ticks simulated so far. */
  tick: number;
  /** World PRNG; advanced by spawns and food. */
  rng: RngState;
  /** Living snakes in spawn order. Order matters only for tie-breaks. */
  snakes: Snake[];
  food: Food[];
  nextFoodId: number;
  /** Lives that ended during the last `step` (cleared at the start of each step). */
  deaths: Death[];
}
