/**
 * A point or vector in world units.
 *
 * Coordinates are maths-style: the origin is the centre of the arena, `x` grows to the
 * right (east) and `y` grows UP (north).
 */
export interface Vec {
  x: number;
  y: number;
}

/** What a bot returns each tick. */
export interface BotAction {
  /**
   * Steering in [-1, 1]. `-1` is full left (counter-clockwise, the heading angle increases),
   * `1` is full right (clockwise, the angle decreases), `0` goes straight.
   * The heading changes by `-turn * self.turnRate` radians this tick (note the minus: angles
   * are counter-clockwise, but positive `turn` means right).
   * Values outside [-1, 1] are clamped; `NaN` and non-numbers count as `0`. The engine rounds
   * the result to the nearest multiple of 1/128 (so replays can store it in a byte).
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
  /**
   * The arena is a square centred on (0, 0) reaching this far along each axis: `x` and `y` both
   * lie in [-worldHalfSize, worldHalfSize]. Your head crossing an edge kills you.
   */
  worldHalfSize: number;
  /** You see snakes and food whose distance from your head is at most this. */
  visionRadius: number;
  /** Simulation ticks per second of game time (wall-clock speed may differ). */
  tickRate: number;
  /**
   * Safety cap on a life: a snake still alive after this many ticks "retires" with its score.
   * 864 000 (24 hours of game time) in the arena, so in practice a life lasts until you die.
   */
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
   * Heading in radians, counter-clockwise from +x, normalised to (-π, π]. `0` points east (+x),
   * `π/2` north (+y, up), `-π/2` south, `π` west. `Math.atan2(dy, dx)` gives the heading to a
   * point directly. Compare angles with {@link angleDiff}, never with `-`.
   */
  angle: number;
  /** Current length. This is your score driver: it grows by eating food and decays with hunger. */
  length: number;
  /** Distance moved this tick, in world units per tick (higher while boosting). */
  speed: number;
  /** Body radius. Collisions use it: you die when your head circle touches another body circle. */
  radius: number;
  /** Max heading change per tick in radians, reached at `turn = ±1`. Don't hard-code it. */
  turnRate: number;
  /** Whether you boosted this tick. */
  boosting: boolean;
  /**
   * Ticks of spawn grace left, the coming one included; 0 once it is over. A new life starts with
   * some (currently 15 ticks, 1.5 s). While it lasts no other snake can kill you and you kill
   * none: bodies and heads pass through each other. The wall still kills, and you can eat.
   */
  spawnGrace: number;
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
   * Its spawn grace left (see {@link SelfState.spawnGrace}). While it is above 0 that snake can't
   * kill you and you can't kill it: its body isn't solid, so don't waste a cut on it, and don't
   * stay inside its body when the grace runs out.
   */
  spawnGrace: number;
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
   * Distance from your head to the nearest arena edge
   * (`worldHalfSize - max(|head.x|, |head.y|)`). You die when it drops below 0, i.e. when your
   * head point crosses an edge. In a corner two edges are this close or nearly so; see
   * {@link nearestWall} and {@link distanceToWallAlong}, or {@link angleTo}`(self.head, CENTER)`
   * to head inwards.
   */
  wallDistance: number;
}
