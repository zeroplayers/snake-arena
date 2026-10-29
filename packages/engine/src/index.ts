/**
 * @zerosnake/engine — deterministic fixed-step snake simulation (SPEC §3).
 *
 *   const world = createWorld({ seed: 42 });
 *   spawnSnake(world, { id: "a", author: "alice" });
 *   step(world, { a: { turn: 0.3, boost: false } });
 *   world.deaths; // lives that ended this tick
 *
 * `buildBotState(world, id)` is what that snake's bot sees this tick (`BotState` of
 * `@zerosnake/sdk`); `buildBotInfo` is what its `init()` gets.
 *
 * Record a room with `ReplayRecorder` (use its `spawn`/`step`); play it back and seek with
 * `ReplayPlayer`. Spectators get a room as state deltas (`BroadcastEncoder` → `encodeBroadcast`,
 * `decodeBroadcast` → `BroadcastView`).
 *
 * `step` mutates in place; `cloneWorld` snapshots. A world is plain data, so it also survives
 * JSON round-trips and storage.
 */
export {
  BROADCAST_VERSION,
  type BroadcastDeath,
  BroadcastEncoder,
  type BroadcastEncoderOptions,
  type BroadcastFood,
  BroadcastFormatError,
  BroadcastGapError,
  type BroadcastLabel,
  type BroadcastLife,
  type BroadcastMessage,
  type BroadcastSnake,
  BroadcastView,
  decodeBroadcast,
  encodeBroadcast,
  type Keyframe,
  MAX_TRAIL_POINTS,
  type TickDelta,
  type TicksMessage,
  type ViewDeath,
  type ViewSnake,
} from "./broadcast.ts";
export {
  createConfig,
  DEFAULT_CONFIG,
  type EngineConfig,
  rulesId,
  sameRules,
  TICK_RATE,
} from "./config.ts";
export { hungerDecay, lifeScore, segmentCountForMass, sizeForMass } from "./growth.ts";
export { hashWorld } from "./hash.ts";
export {
  CHUNK_TICKS,
  decodeReplayChunk,
  encodeReplayChunk,
  HASH_EVERY,
  REPLAY_VERSION,
  type ReplayChunk,
  type ReplayChunkInfo,
  ReplayDesyncError,
  ReplayPlayer,
  type ReplayPlayerOptions,
  ReplayRecorder,
  type ReplayRecorderOptions,
  type ReplayTick,
  replayChunkInfo,
  replayChunkVersion,
} from "./replay.ts";
export { createRng, type Rng, type RngState } from "./rng.ts";
export { spawnGraceLeft } from "./spawn.ts";
export { quantizeTurn, step, TURN_STEPS } from "./step.ts";
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
export { type BotLimits, buildBotInfo, buildBotState } from "./vision.ts";
export {
  type CreateWorldOptions,
  cloneWorld,
  createWorld,
  type SpawnOptions,
  spawnSnake,
} from "./world.ts";
