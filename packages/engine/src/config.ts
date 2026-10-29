/**
 * Every tunable coefficient of the simulation. A world stores its config, so replays stay
 * reproducible after the defaults change.
 *
 * Units: distances are world units, time is ticks (`TICK_RATE` per second), angles are radians.
 * The original ZeroSnake ran at ~60 fps with speed 0.015 units/ms, world 100×100, segment
 * spacing 1–5; the values below keep that scale at 10 ticks/s.
 */
export interface EngineConfig {
  // --- Arena ---------------------------------------------------------------------------------
  /**
   * Half the side of the square arena, centred on (0, 0). A head beyond its edge
   * (`max(|x|, |y|) > arenaHalfSize`) dies by `wall`.
   */
  arenaHalfSize: number;

  // --- Movement ------------------------------------------------------------------------------
  /** Distance a head covers per tick (original: 0.015 u/ms × 100 ms). */
  speed: number;
  /** Speed multiplier while boosting. */
  boostMultiplier: number;
  /** Max heading change per tick at `turn = ±1`. */
  turnRate: number;

  // --- Growth (original `snake_growth_simulation_guide.md`) ----------------------------------
  /** Segment spacing ("size") at zero mass — MIN_PLAYER_SIZE. */
  minSize: number;
  /** Segment spacing cap — MAX_PLAYER_SIZE. */
  maxSize: number;
  /** Mass at which size reaches `maxSize` — MAX_SCORE. */
  sizeMassCap: number;
  /** Segments per unit of mass/size: count = floor(mass × this / size + baseSegments). */
  segmentMassFactor: number;
  /** Segments a snake has at zero mass (the original's "+5"). */
  baseSegments: number;
  /** Mass a new life starts with. */
  startMass: number;
  /** Mass never drops below this (hunger and boost stop there). */
  minMass: number;

  // --- Boost ---------------------------------------------------------------------------------
  /** Mass burned per boosted tick. */
  boostCost: number;
  /** Boost is refused below this mass. */
  boostMinMass: number;
  /** Fraction of burned mass dropped as food at the tail. */
  boostDropRatio: number;

  // --- Hunger --------------------------------------------------------------------------------
  /** Flat mass loss per tick. */
  hungerFlat: number;
  /** Proportional mass loss per tick (mass × rate). */
  hungerRate: number;

  // --- Food ----------------------------------------------------------------------------------
  /** Value of an ambient pellet. */
  foodValue: number;
  /** Food the world tops up to: base + perSnake × alive snakes (all kinds count). */
  foodBase: number;
  foodPerSnake: number;
  /** Ambient pellets spawned per tick at most while below the target. */
  foodSpawnPerTick: number;
  /** Hard cap on food items; ambient and boost drops stop above it (remains never do). */
  maxFood: number;
  /** Eat radius = size × eatRadiusFactor + the pellet's radius (original: size × 3). */
  eatRadiusFactor: number;
  /** Pellet radius for ambient/boost food (original: 0.5). */
  foodRadius: number;
  /** Pellet radius for remains of dead snakes (original type 7: 1.5). */
  remainsRadius: number;
  /** Food is only eaten inside a forward cone: cos(angle to food) > this (original: 0.5). */
  eatCone: number;

  // --- Death ---------------------------------------------------------------------------------
  /** Fraction of a dead snake's mass dropped as remains. */
  deathDropRatio: number;
  /** Largest value of a single remains pellet (original: 10). */
  remainsMaxValue: number;
  /** Remains are scattered up to this × size from their segment. */
  remainsJitter: number;

  // --- Life ----------------------------------------------------------------------------------
  /** A snake retires after this many ticks alive. */
  lifeCap: number;
  /** Score per unit of mass per tick (area under the mass curve). */
  massScoreFactor: number;
  /** Score per kill. */
  killBonus: number;

  // --- Spawning ------------------------------------------------------------------------------
  /** New snakes spawn within the centred square of half-side arenaHalfSize × this. */
  spawnHalfSizeFactor: number;
  /**
   * A spawn point with this much room (between body circles) to every other snake's body, head
   * and the road its head takes next is good enough; failing that, the roomiest point is taken.
   * The old spawn (`spawnCandidates` absent) only measured it to body points.
   */
  spawnClearance: number;
  /** Random positions the old spawn tries before settling for the last one. */
  spawnAttempts: number;
  /**
   * Random positions scored per spawn (#102). Absent (worlds saved before it) or 0: the old
   * spawn, the first of `spawnAttempts` positions clear of bodies, facing the centre.
   */
  spawnCandidates: number;
  /**
   * For its first this many ticks a new snake takes no part in snake-to-snake collisions (#102):
   * its body isn't solid and nothing but the wall kills it. Absent (worlds saved before it): 0.
   */
  spawnGraceTicks: number;

  // --- Vision (bot state) --------------------------------------------------------------------
  /** A bot sees snake points and food at most this far from its head. */
  visionRadius: number;
  /** Most other snakes in one state (the nearest are kept). */
  visionMaxSnakes: number;
  /** Most body points over all other snakes in one state; bodies are downsampled to fit. */
  visionMaxSegments: number;
  /** Most points of the bot's own body in its state; downsampled to fit. */
  visionMaxSelfSegments: number;
  /** Most food pellets in one state (the nearest are kept). */
  visionMaxFood: number;

  // --- Internals -----------------------------------------------------------------------------
  /** Spatial hash cell size. Does not affect results, only speed. */
  gridCellSize: number;
}

/** Ticks per second. Informational: all physics is per tick. */
export const TICK_RATE = 10;

export const DEFAULT_CONFIG: Readonly<EngineConfig> = Object.freeze({
  // About the area of the disc of radius 100 it replaced (100 × √π / 2 ≈ 88.6), so food
  // density and balance stay the same.
  arenaHalfSize: 89,

  speed: 1.5,
  boostMultiplier: 2,
  turnRate: 0.25,

  minSize: 1,
  maxSize: 5,
  sizeMassCap: 10_000,
  segmentMassFactor: 0.1,
  baseSegments: 5,
  startMass: 10,
  minMass: 0,

  boostCost: 1,
  boostMinMass: 5,
  boostDropRatio: 1,

  hungerFlat: 0.002,
  hungerRate: 0.0003,

  foodValue: 1,
  foodBase: 150,
  foodPerSnake: 40,
  foodSpawnPerTick: 4,
  maxFood: 3000,
  eatRadiusFactor: 3,
  foodRadius: 0.5,
  remainsRadius: 1.5,
  eatCone: 0.5,

  deathDropRatio: 1,
  remainsMaxValue: 10,
  remainsJitter: 0.5,

  lifeCap: 6000,
  massScoreFactor: 0.001,
  killBonus: 50,

  spawnHalfSizeFactor: 0.8,
  spawnClearance: 10,
  spawnAttempts: 30,
  spawnCandidates: 24,
  spawnGraceTicks: 15,

  visionRadius: 40,
  visionMaxSnakes: 32,
  visionMaxSegments: 256,
  visionMaxSelfSegments: 128,
  visionMaxFood: 128,

  gridCellSize: 8,
});

export function createConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}
