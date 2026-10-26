/**
 * @zerosnake/engine — deterministic fixed-step snake simulation (SPEC §3).
 *
 *   const world = createWorld({ seed: 42 });
 *   spawnSnake(world, { id: "a", author: "alice" });
 *   step(world, { a: { turn: 0.3, boost: false } });
 *   world.deaths; // lives that ended this tick
 *
 * `step` mutates in place; `cloneWorld` snapshots. A world is plain data, so it also survives
 * JSON round-trips and storage.
 */
export {
  createConfig,
  DEFAULT_CONFIG,
  type EngineConfig,
  TICK_RATE,
} from "./config.ts";
export { hungerDecay, lifeScore, segmentCountForMass, sizeForMass } from "./growth.ts";
export { createRng, type Rng, type RngState } from "./rng.ts";
export { step } from "./step.ts";
export type {
  Action,
  ActionMap,
  Death,
  DeathCause,
  Fault,
  FaultMap,
  Food,
  FoodKind,
  Snake,
  SnakeId,
  Vec2,
  World,
} from "./types.ts";
export {
  type CreateWorldOptions,
  cloneWorld,
  createWorld,
  type SpawnOptions,
  spawnSnake,
} from "./world.ts";
