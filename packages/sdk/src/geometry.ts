import type { BotState, Food, SelfState, SnakeView, Vec } from "./types.ts";

/** A full turn in radians (2π). */
export const TAU = Math.PI * 2;

/** The arena centre. Steer toward it to get away from the wall. */
export const CENTER: Vec = { x: 0, y: 0 };

/** Clamps `value` into [min, max]. `NaN` becomes `min`. */
export function clamp(value: number, min: number, max: number): number {
  if (!(value >= min)) return min;
  return Math.min(value, max);
}

/** Straight-line distance between two points. */
export function distance(a: Vec, b: Vec): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Squared distance. Cheaper than {@link distance}; fine for comparing which is closer. */
export function distanceSq(a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dx * dx + dy * dy;
}

/**
 * Wraps any angle into (-π, π].
 *
 * @example normalizeAngle(3 * Math.PI / 2) // -π/2
 */
export function normalizeAngle(angle: number): number {
  const a = angle - TAU * Math.floor((angle + Math.PI) / TAU);
  // floor puts π into [-π, π); flip the edge so the range is (-π, π].
  return a === -Math.PI ? Math.PI : a;
}

/**
 * Heading (radians, in (-π, π]) you would need to go from `from` straight to `to`.
 * Same convention as {@link SelfState.angle}: counter-clockwise from +x, 0 = east, π/2 = north
 * (y grows up).
 * Returns 0 if the points are equal.
 */
export function angleTo(from: Vec, to: Vec): number {
  return normalizeAngle(Math.atan2(to.y - from.y, to.x - from.x));
}

/**
 * Signed smallest rotation from angle `from` to angle `to`, in (-π, π].
 * Positive means `to` is to your LEFT (counter-clockwise), negative means RIGHT (clockwise).
 * Careful: that is the opposite sign of `turn` (positive `turn` = right); {@link turnToward}
 * does the conversion for you. Always use this instead of `to - from`, which breaks across ±π.
 *
 * @example angleDiff(Math.PI - 0.1, -Math.PI + 0.1) // 0.2 (a small left turn, not -6.08)
 */
export function angleDiff(from: number, to: number): number {
  return normalizeAngle(to - from);
}

/**
 * The `turn` value that rotates your heading toward `targetAngle` as fast as allowed without
 * overshooting: `-angleDiff / self.turnRate`, clamped to [-1, 1]. Negative (left) when the
 * target is counter-clockwise of your heading, positive (right) when clockwise. Put the result
 * straight into {@link BotAction.turn}.
 */
export function turnToward(
  self: Pick<SelfState, "angle" | "turnRate">,
  targetAngle: number,
): number {
  // Angles are counter-clockwise, `turn` is positive to the right (clockwise), so measure the
  // clockwise rotation: arguments swapped on purpose (also avoids returning -0).
  const diff = angleDiff(targetAngle, self.angle);
  if (self.turnRate <= 0) return diff === 0 ? 0 : Math.sign(diff);
  return clamp(diff / self.turnRate, -1, 1);
}

/** The `turn` value that steers your head toward `point`. See {@link turnToward}. */
export function steerToward(
  self: Pick<SelfState, "head" | "angle" | "turnRate">,
  point: Vec,
): number {
  return turnToward(self, angleTo(self.head, point));
}

/** The `turn` value that steers your head directly away from `point`. See {@link turnToward}. */
export function steerAway(
  self: Pick<SelfState, "head" | "angle" | "turnRate">,
  point: Vec,
): number {
  return turnToward(self, angleTo(point, self.head));
}

/** The point `dist` units from `origin` along heading `angle`. Handy for looking ahead. */
export function project(origin: Vec, angle: number, dist: number): Vec {
  return { x: origin.x + Math.cos(angle) * dist, y: origin.y + Math.sin(angle) * dist };
}

/**
 * Distance from `point` to the nearest edge of the square arena (negative if outside):
 * `worldHalfSize - max(|x|, |y|)`. For your head this is `state.wallDistance`.
 */
export function distanceToWall(point: Vec, worldHalfSize: number): number {
  return worldHalfSize - Math.max(Math.abs(point.x), Math.abs(point.y));
}

/** Result of {@link nearestWall}. */
export interface Wall {
  /** Same as {@link distanceToWall}. */
  distance: number;
  /** Unit vector pointing away from that wall, into the arena: e.g. `{ x: -1, y: 0 }` for the east wall. */
  normal: Vec;
}

/**
 * The arena edge closest to `point` and the direction away from it. Near a corner two edges
 * are about as close; pass the heading `Math.atan2(normal.y, normal.x)` to {@link turnToward}
 * to back off the nearest one, or steer for {@link CENTER} to leave the corner.
 */
export function nearestWall(point: Vec, worldHalfSize: number): Wall {
  const ax = Math.abs(point.x);
  const ay = Math.abs(point.y);
  const normal = ax >= ay ? { x: point.x > 0 ? -1 : 1, y: 0 } : { x: 0, y: point.y > 0 ? -1 : 1 };
  return { distance: worldHalfSize - Math.max(ax, ay), normal };
}

/**
 * How far `origin` can travel straight along heading `angle` before its centre crosses an
 * arena edge (0 if already outside). Unlike {@link distanceToWall}, this is what you have left
 * on your current road: heading along a wall, it is large even when the wall is close.
 */
export function distanceToWallAlong(origin: Vec, angle: number, worldHalfSize: number): number {
  if (Math.max(Math.abs(origin.x), Math.abs(origin.y)) >= worldHalfSize) return 0;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let t = Number.POSITIVE_INFINITY;
  if (dx !== 0) t = Math.min(t, ((dx > 0 ? worldHalfSize : -worldHalfSize) - origin.x) / dx);
  if (dy !== 0) t = Math.min(t, ((dy > 0 ? worldHalfSize : -worldHalfSize) - origin.y) / dy);
  return t;
}

/** The item closest to `from`, or `undefined` if `items` is empty. Works on food or points. */
export function nearest<T extends Vec>(from: Vec, items: readonly T[]): T | undefined {
  let best: T | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const d = distanceSq(from, item);
    if (d < bestD) {
      bestD = d;
      best = item;
    }
  }
  return best;
}

/** The visible food closest to your head, or `undefined` if none is in vision. */
export function nearestFood(state: Pick<BotState, "self" | "food">): Food | undefined {
  return nearest(state.self.head, state.food);
}

/** Result of {@link nearestDanger}. */
export interface Danger {
  /** The snake the point belongs to. */
  snake: SnakeView;
  /** The closest visible body point of that snake. */
  point: Vec;
  /** Centre-to-centre distance from your head to `point`. */
  distance: number;
  /**
   * Free space between your head and that body: `distance - self.radius - snake.radius`.
   * You die when this reaches 0.
   */
  gap: number;
}

/**
 * The closest visible body point of any other snake (heads included), or `undefined` if no
 * snake is in vision. Does not consider the wall; check `state.wallDistance` for that.
 */
export function nearestDanger(state: Pick<BotState, "self" | "snakes">): Danger | undefined {
  const head = state.self.head;
  let best: Danger | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  for (const snake of state.snakes) {
    for (const point of snake.segments) {
      const d = distanceSq(head, point);
      if (d < bestD) {
        bestD = d;
        best = { snake, point, distance: 0, gap: 0 };
      }
    }
  }
  if (!best) return undefined;
  best.distance = Math.sqrt(bestD);
  best.gap = best.distance - state.self.radius - best.snake.radius;
  return best;
}
