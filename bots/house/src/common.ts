/**
 * Helpers shared by the house bots. Everything here is cheap enough for the sandbox budget:
 * one pass over the visible segments to collect nearby obstacles, then three ray casts over
 * them per candidate heading (17 candidates), so even a crowded view costs about ten thousand
 * distance checks per tick (≈2 QuickJS interrupts; the spike's 16×20 lookahead took 13–20).
 */
import {
  angleDiff,
  angleTo,
  type BotState,
  clamp,
  distance,
  type Food,
  normalizeAngle,
  type SelfState,
  type SnakeView,
  type Vec,
} from "@zerosnake/sdk";

/** Arena radius, recovered from the head position and `wallDistance` (no `info` needed). */
export function arenaRadius(state: Pick<BotState, "self" | "wallDistance">): number {
  return Math.hypot(state.self.head.x, state.self.head.y) + state.wallDistance;
}

/** Radius of the tightest circle the snake can drive at its current speed. */
export function turnRadius(self: Pick<SelfState, "speed" | "turnRate">): number {
  return self.turnRate > 0 ? self.speed / self.turnRate : Number.POSITIVE_INFINITY;
}

/**
 * Whether food can be driven over without orbiting it. A point at distance `d` and bearing `φ`
 * off the heading lies on a circle of radius `d / (2 |sin φ|)` through the head; it is
 * reachable when that circle is no tighter than the turning circle (with a little slack for
 * the eat radius).
 */
export function reachable(self: SelfState, point: Vec): boolean {
  const d = distance(self.head, point);
  const phi = angleDiff(self.angle, angleTo(self.head, point));
  return d + self.radius * 4 >= 2 * turnRadius(self) * Math.abs(Math.sin(phi));
}

/** The nearest food that can be reached without orbiting it. */
export function nearestReachableFood(state: Pick<BotState, "self" | "food">): Food | undefined {
  const { self } = state;
  let best: Food | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  for (const f of state.food) {
    const dx = f.x - self.head.x;
    const dy = f.y - self.head.y;
    const d = dx * dx + dy * dy;
    if (d < bestD && reachable(self, f)) {
      bestD = d;
      best = f;
    }
  }
  return best;
}

/**
 * The food with the best value per unit of travel, counting the turn needed to face it, and
 * skipping food that would need an orbit. `avoid` lets a bot skip food lying in danger.
 */
export function bestFood(
  state: Pick<BotState, "self" | "food">,
  avoid?: (food: Food) => boolean,
): Food | undefined {
  const { self } = state;
  const r = turnRadius(self);
  let best: Food | undefined;
  let bestScore = 0;
  for (const f of state.food) {
    const d = distance(self.head, f);
    const turn = Math.abs(angleDiff(self.angle, angleTo(self.head, f)));
    const score = f.value / (d + turn * r + 1);
    if (score <= bestScore || !reachable(self, f) || avoid?.(f)) continue;
    bestScore = score;
    best = f;
  }
  return best;
}

/** A circle the head must not enter: `r` already includes our own radius. */
export interface Obstacle {
  x: number;
  y: number;
  r: number;
}

export interface ObstacleOptions {
  /** Ignore points farther than this from the head. */
  range: number;
  /** Extra clearance added to every body circle. */
  margin: number;
  /**
   * How many ticks ahead to project the heads of other snakes (0 = only where they are now).
   * A projected head blocks the road it is about to take.
   */
  headLead: number;
  /** Heads of these snakes are left out (bodies still count), e.g. smaller snakes we hunt. */
  harmlessHead?: (snake: SnakeView) => boolean;
}

/** Collects the visible bodies of other snakes near the head as circles to steer around. */
export function collectObstacles(
  state: Pick<BotState, "self" | "snakes">,
  o: ObstacleOptions,
): Obstacle[] {
  const { head, radius, speed, boosting } = state.self;
  const baseSpeed = boosting ? speed / 2 : speed;
  const range2 = (o.range + o.margin + radius) ** 2;
  const out: Obstacle[] = [];
  for (const snake of state.snakes) {
    const r = radius + snake.radius + o.margin;
    const skipHead = snake.head !== null && (o.harmlessHead?.(snake) ?? false);
    for (let i = skipHead ? 1 : 0; i < snake.segments.length; i++) {
      const p = snake.segments[i] as Vec;
      const dx = p.x - head.x;
      const dy = p.y - head.y;
      if (dx * dx + dy * dy <= range2) out.push({ x: p.x, y: p.y, r });
    }
    if (skipHead || snake.head === null || snake.angle === null || o.headLead <= 0) continue;
    const v = snake.boosting ? baseSpeed * 2 : baseSpeed;
    const cx = Math.cos(snake.angle) * v;
    const cy = Math.sin(snake.angle) * v;
    for (let k = 1; k <= o.headLead; k++) {
      const x = snake.head.x + cx * k;
      const y = snake.head.y + cy * k;
      const dx = x - head.x;
      const dy = y - head.y;
      if (dx * dx + dy * dy <= range2) out.push({ x, y, r });
    }
  }
  return out;
}

/**
 * Free distance from `from` along heading `angle` before touching an obstacle or the wall,
 * capped at `maxDist`. `wallRadius` should already be shrunk by our own radius.
 */
export function castRay(
  from: Vec,
  angle: number,
  obstacles: readonly Obstacle[],
  wallRadius: number,
  maxDist: number,
): number {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  // Wall: solve |from + t·d| = wallRadius for the exit point.
  const b = from.x * dx + from.y * dy;
  const c = from.x * from.x + from.y * from.y - wallRadius * wallRadius;
  let best = c >= 0 ? 0 : Math.min(maxDist, -b + Math.sqrt(b * b - c));
  for (const o of obstacles) {
    const px = o.x - from.x;
    const py = o.y - from.y;
    const t = px * dx + py * dy;
    if (t <= 0 || t - o.r >= best) continue;
    const perp2 = px * px + py * py - t * t;
    const r2 = o.r * o.r;
    if (perp2 >= r2) continue;
    const hit = t - Math.sqrt(r2 - perp2);
    best = Math.max(hit, 0);
  }
  return best;
}

/**
 * Free distance along the road to heading `self.angle + offset` the way a snake actually gets
 * there: a full-rate turn along the turning circle, then straight on. The arc is checked as two
 * chords, so the result is in path length, capped at `maxDist`.
 */
export function pathClearance(
  self: Pick<SelfState, "head" | "angle" | "speed" | "turnRate">,
  offset: number,
  obstacles: readonly Obstacle[],
  wallRadius: number,
  maxDist: number,
): number {
  const r = turnRadius(self);
  const { head, angle } = self;
  if (offset === 0 || !Number.isFinite(r))
    return castRay(head, angle, obstacles, wallRadius, maxDist);
  // Left turns (offset > 0) circle around a centre on the left of the heading.
  const side = offset > 0 ? 1 : -1;
  const cx = head.x - side * r * Math.sin(angle);
  const cy = head.y + side * r * Math.cos(angle);
  const at = (phi: number): Vec => ({
    x: cx + side * r * Math.sin(angle + phi),
    y: cy - side * r * Math.cos(angle + phi),
  });
  const halfArc = (r * Math.abs(offset)) / 2;
  let travelled = 0;
  let from = head;
  for (const to of [at(offset / 2), at(offset)]) {
    const chord = distance(from, to);
    const hit = castRay(from, angleTo(from, to), obstacles, wallRadius, chord);
    if (hit < chord) return Math.min(maxDist, travelled + (hit * halfArc) / chord);
    travelled += halfArc;
    if (travelled >= maxDist) return maxDist;
    from = to;
  }
  return travelled + castRay(from, angle + offset, obstacles, wallRadius, maxDist - travelled);
}

export interface SteerOptions {
  /** Number of headings tried, spread evenly around the full circle (plus `desired` itself). */
  rays: number;
  /** How far each path is checked. */
  lookahead: number;
  /** Clearance below which a heading starts to be penalised. */
  safe: number;
  /** Penalty (in radians of misalignment) for a heading that is blocked right away. */
  dangerWeight: number;
  /**
   * Extra cost (in radians) for turning the other way than last tick. Without it a snake caught
   * between two equally bad roads (typically along the wall) flips its turn every tick and in
   * effect drives straight on.
   */
  reversalCost?: number;
}

export interface Steer {
  /**
   * The `turn` toward the chosen heading, in the direction the path was planned (unlike
   * `turnToward`, which may pick the other way round for a U-turn).
   */
  turn: number;
  /** Chosen heading. */
  angle: number;
  /** Free distance along it. */
  clearance: number;
  /** Free distance straight ahead. */
  ahead: number;
}

/**
 * Picks the heading closest to `desired` that is not blocked. Each candidate costs its
 * misalignment with `desired` plus a penalty that grows as its clearance drops below `safe`;
 * headings that need a bigger turn pay a little extra, because the turn itself takes time.
 */
export function steer(
  state: Pick<BotState, "self" | "wallDistance">,
  obstacles: readonly Obstacle[],
  desired: number,
  o: SteerOptions,
  /** The `turn` sent last tick (0 on the first). */
  previousTurn = 0,
): Steer {
  const { self } = state;
  const wall = arenaRadius(state) - self.radius;
  const step = (Math.PI * 2) / o.rays;
  let bestOffset = 0;
  let bestClearance = 0;
  let bestCost = Number.POSITIVE_INFINITY;
  let ahead = 0;
  // Candidate -1 is `desired` itself, so an open road is taken exactly; then 0, +1, -1, +2, -2,
  // ... steps around the current heading (ties go to the smaller turn).
  for (let k = -1; k < o.rays; k++) {
    const offset =
      k < 0 ? angleDiff(self.angle, desired) : (k % 2 === 1 ? (k + 1) / 2 : -k / 2) * step;
    const angle = self.angle + offset;
    const clearance = pathClearance(self, offset, obstacles, wall, o.lookahead);
    if (k === 0) ahead = clearance;
    const danger = clearance >= o.safe ? 0 : (1 - clearance / o.safe) * o.dangerWeight;
    // `turn` and `offset` have opposite signs, so the same sign means turning the other way.
    const reversal = offset * previousTurn > 0 ? (o.reversalCost ?? 0) : 0;
    const cost = Math.abs(angleDiff(angle, desired)) + Math.abs(offset) * 0.15 + danger + reversal;
    if (cost < bestCost) {
      bestCost = cost;
      bestOffset = offset;
      bestClearance = clearance;
    }
  }
  const turn =
    self.turnRate > 0 ? clamp(-bestOffset / self.turnRate, -1, 1) : -Math.sign(bestOffset);
  return { turn, angle: normalizeAngle(self.angle + bestOffset), clearance: bestClearance, ahead };
}

/** mulberry32: a tiny seeded PRNG, so a bot's randomness is reproducible from `info.seed`. */
export function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
