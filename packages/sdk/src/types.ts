/**
 * A point or vector in world units.
 *
 * Coordinates are screen-style: the origin is the centre of the arena, `x` grows to the
 * right (east) and `y` grows DOWN (south).
 */
export interface Vec {
  x: number;
  y: number;
}

/** What a bot returns each tick. */
export interface BotAction {
  /**
   * Steering in [-1, 1]. `-1` is full left (counter-clockwise on screen, the heading angle
   * decreases), `1` is full right (clockwise, the angle increases), `0` goes straight.
   * The heading changes by `turn * self.turnRate` radians this tick.
   * Values outside [-1, 1] are clamped; `NaN` and non-numbers count as `0`.
   * Prefer {@link turnToward} / {@link steerToward} over computing this by hand.
   */
  turn: number;
  /**
   * Move faster this tick. Boosting burns length and drops food behind you; it is ignored
   * when the snake is too short to boost. Defaults to `false`.
   */
  boost?: boolean;
}

/**
 * Facts that stay fixed for a whole life. Passed once to `init()` at the start of each life.
 */
export interface BotInfo {
  /** Your snake's id for this life; matches `state.self.id`. */
  snakeId: string;
  /** The arena is a circle of this radius centred on (0, 0). Touching its edge kills you. */
  worldRadius: number;
  /** You see snakes and food whose distance from your head is at most this. */
  visionRadius: number;
  /** Simulation ticks per second of game time (wall-clock speed may differ). */
  tickRate: number;
  /** The life ends ("retires" with its score) after this many ticks. */
  maxLifeTicks: number;
  /**
   * QuickJS operation budget for one `tick()` call. Going over reuses your previous action and
   * adds a strike; three strikes in a row is death by timeout.
   */
  opBudget: number;
  /** Max UTF-8 bytes of `log()` output kept per tick. Equals {@link LOG_LIMIT_BYTES}. */
  logLimitBytes: number;
  /**
   * Seed of this life's PRNG. `Math.random()` inside the sandbox is already seeded from it, so
   * you never need it to be deterministic; it is here so you can tell lives apart in logs.
   */
  seed: number;
}

/** Your own snake, always fully visible. */
export interface SelfState {
  /** Same as `info.snakeId`. */
  id: string;
  /** Head position (same as `segments[0]`). */
  head: Vec;
  /**
   * Heading in radians, normalised to (-π, π]. `0` points to +x (east), `π/2` to +y (south,
   * down on screen), `-π/2` to north. Compare angles with {@link angleDiff}, never with `-`.
   */
  angle: number;
  /** Current length. This is your score driver: it grows by eating food and decays with hunger. */
  length: number;
  /** Distance moved this tick, in world units per tick (higher while boosting). */
  speed: number;
  /** Body radius. Collisions use it: you die when your head circle touches another body circle. */
  radius: number;
  /** Max heading change per tick in radians, reached at `turn = ±1`. Shrinks as you grow. */
  turnRate: number;
  /** Whether you boosted this tick. */
  boosting: boolean;
  /**
   * Body points from head (`[0]`) to tail. May be downsampled to keep state small, so the spacing
   * between points is not guaranteed; treat the body as circles of `radius` around each point.
   */
  segments: Vec[];
}

/** Another snake, as far as you can see it. */
export interface SnakeView {
  /** Unique within the room; stable for the life of that snake. */
  id: string;
  /** Username of the bot's author (house bots use `"house"`). */
  author: string;
  /** Full length, even if only part of the body is visible. */
  length: number;
  /** Body radius; see {@link SelfState.radius}. */
  radius: number;
  /** Head position, or `null` if the head is outside your vision. */
  head: Vec | null;
  /** Heading in radians (same convention as {@link SelfState.angle}), or `null` if head is hidden. */
  angle: number | null;
  /** Whether it boosted this tick. */
  boosting: boolean;
  /**
   * Only the body points within your vision radius, ordered head-to-tail. Can be non-contiguous
   * (the body may leave and re-enter your vision) and downsampled. Never empty.
   */
  segments: Vec[];
}

/** A food pellet. Eat it by touching it with your head. */
export interface Food extends Vec {
  /** Length gained by eating it. */
  value: number;
}

/**
 * Everything your bot sees on one tick. Plain JSON data: no classes, no methods.
 * Objects outside {@link BotInfo.visionRadius} of your head never appear here.
 */
export interface BotState {
  /** Room tick number; keeps counting across lives. */
  tick: number;
  /** Ticks since this life started; `0` on the first `tick()` call. */
  lifeTick: number;
  /** Your own snake. */
  self: SelfState;
  /** Other snakes with at least one body point in vision. Does not include you. */
  snakes: SnakeView[];
  /** Food within vision. */
  food: Food[];
  /**
   * Distance from your head to the arena edge (`worldRadius - |head|`). You die when it drops
   * to `self.radius` or below. Use {@link angleTo}`(self.head, {x: 0, y: 0})` to head inwards.
   */
  wallDistance: number;
}
