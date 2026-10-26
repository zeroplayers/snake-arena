/**
 * `@zerosnake/sdk`: types and helpers for writing ZeroSnake bots.
 *
 * A bot module default-exports {@link defineBot}`({ init, tick })`. Each tick it receives a
 * {@link BotState} and returns a {@link BotAction} (`{ turn, boost? }`).
 *
 * World conventions (the engine must produce state that honours all of these):
 * - Units: positions, lengths, radii and distances are world units; speed is world units per
 *   tick; angles and `turnRate` are radians; time is ticks (`info.tickRate` per second).
 * - Coordinates: origin (0, 0) is the arena centre; `x` grows east (right), `y` grows south
 *   (DOWN, as on a screen). The arena is a circle of `info.worldRadius` around the origin.
 * - Angles: 0 points to +x, π/2 to +y; angles in state are normalised to (-π, π].
 *   Increasing angle is clockwise on screen.
 * - Turning: `turn` > 0 turns right (angle increases), `turn` < 0 turns left. Each tick the
 *   engine applies `angle += clamp(turn, -1, 1) * self.turnRate` (NaN turn = 0).
 * - Vision: an object appears in state only if its distance from your head is at most
 *   `info.visionRadius`; for other snakes only the visible body points are listed.
 * - Segments are ordered head first; `self.segments[0]` equals `self.head`.
 * - `lifeTick` is 0 on the first `tick()` of a life; `tick` is the room's tick counter.
 * - State is plain JSON (it is copied into a QuickJS sandbox every tick). Memory (`mem`) is
 *   NOT copied: it lives inside the sandbox for the whole life, so it may hold anything.
 * - The SDK itself has no dependencies and uses no host APIs, so it runs inside QuickJS.
 *
 * @packageDocumentation
 */

export { type Bot, defineBot } from "./bot";
export {
  angleDiff,
  angleTo,
  CENTER,
  clamp,
  type Danger,
  distance,
  distanceSq,
  distanceToWall,
  nearest,
  nearestDanger,
  nearestFood,
  normalizeAngle,
  project,
  steerAway,
  steerToward,
  TAU,
  turnToward,
} from "./geometry";
export { createTickLog, LOG_LIMIT_BYTES, type LogFn, type TickLog, utf8Length } from "./log";
export type {
  BotAction,
  BotInfo,
  BotState,
  Food,
  SelfState,
  SnakeView,
  Vec,
} from "./types";
