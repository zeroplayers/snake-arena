import type { BotInfo, BotState, Food as FoodView, SnakeView, Vec } from "@zerosnake/sdk";
import { TICK_RATE } from "./config.ts";
import { foodIndex } from "./food.ts";
import type { Food, Snake, SnakeId, Vec2, World } from "./types.ts";

/**
 * What a bot sees (SPEC §3): the `BotState` / `BotInfo` of `@zerosnake/sdk`, built from a world.
 *
 * Vision is a disc of `config.visionRadius` around the head: a point is visible when its distance
 * from the head is at most the radius. Only visible points of other snakes and visible pellets
 * reach the state. Its size is capped so copying it into the sandbox stays cheap:
 *  - at most `visionMaxSnakes` other snakes, the nearest (by their nearest visible point);
 *  - at most `visionMaxSegments` body points over all of them: when there are more, each body
 *    keeps its first visible point and a share of the rest proportional to how much of it is
 *    visible, evenly spaced along the visible points (first and last kept);
 *  - at most `visionMaxSelfSegments` points of the bot's own body, evenly spaced, head and tail
 *    kept;
 *  - at most `visionMaxFood` pellets, the nearest.
 * Snakes and food are listed nearest first (ties by world order / pellet id).
 *
 * The state shares no objects with the world, so a bot can't reach into it.
 */

/** Sandbox limits that `BotInfo` reports but the engine doesn't know. */
export interface BotLimits {
  opBudget: number;
  logLimitBytes: number;
}

/** The facts passed to a bot's `init()` at the start of `snake`'s life. */
export function buildBotInfo(world: World, snake: Snake, limits: BotLimits): BotInfo {
  const c = world.config;
  return {
    snakeId: snake.id,
    worldRadius: c.arenaRadius,
    visionRadius: c.visionRadius,
    tickRate: TICK_RATE,
    maxLifeTicks: c.lifeCap,
    opBudget: limits.opBudget,
    logLimitBytes: limits.logLimitBytes,
    seed: snake.seed,
  };
}

interface Seen {
  snake: Snake;
  /** Indices of visible segments, head to tail. */
  visible: number[];
  /** Squared distance to the nearest visible segment. */
  d2: number;
  order: number;
}

/** What `snake` (a living snake or its id) sees this tick. */
export function buildBotState(world: World, snake: Snake | SnakeId): BotState {
  const me = typeof snake === "string" ? world.snakes.find((s) => s.id === snake) : snake;
  if (!me) throw new Error(`snake ${String(snake)} is not alive`);
  const c = world.config;
  const hx = me.head.x;
  const hy = me.head.y;
  const r = c.visionRadius;
  const r2 = r * r;

  // Other snakes with at least one visible point.
  let seen: Seen[] = [];
  for (let i = 0; i < world.snakes.length; i++) {
    const other = world.snakes[i] as Snake;
    if (other === me) continue;
    // Segments lie `size` apart along the body, so none is farther from its head than this.
    const reach = r + other.segments.length * other.size;
    const hdx = other.head.x - hx;
    const hdy = other.head.y - hy;
    if (hdx * hdx + hdy * hdy > reach * reach) continue;
    const visible: number[] = [];
    let best = Number.POSITIVE_INFINITY;
    const segs = other.segments;
    for (let k = 0; k < segs.length; k++) {
      const p = segs[k] as Vec2;
      const dx = p.x - hx;
      const dy = p.y - hy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      visible.push(k);
      if (d2 < best) best = d2;
    }
    if (visible.length > 0) seen.push({ snake: other, visible, d2: best, order: i });
  }
  seen.sort((a, b) => a.d2 - b.d2 || a.order - b.order);
  const maxSnakes = Math.max(0, Math.min(c.visionMaxSnakes, c.visionMaxSegments));
  if (seen.length > maxSnakes) seen = seen.slice(0, maxSnakes);

  let total = 0;
  for (const v of seen) total += v.visible.length;
  // Over budget: every snake keeps one point, the rest of the budget is shared out in
  // proportion to each snake's remaining visible points (floored, so the sum never exceeds it).
  const spare = c.visionMaxSegments - seen.length;
  const extra = total - seen.length;
  const snakes: SnakeView[] = seen.map(({ snake: other, visible }) => {
    const keep =
      total <= c.visionMaxSegments
        ? visible.length
        : 1 + Math.floor(((visible.length - 1) * spare) / extra);
    const headVisible = visible[0] === 0;
    return {
      id: other.id,
      author: other.author,
      length: other.mass,
      radius: other.size / 2,
      head: headVisible ? point(other.head) : null,
      angle: headVisible ? other.angle : null,
      boosting: other.boosting,
      segments: evenlySpaced(visible, keep).map((k) => point(other.segments[k] as Vec2)),
    };
  });

  // Food.
  const index = foodIndex(world);
  const near: { food: Food; d2: number }[] = [];
  const c0 = index.col(hx - r);
  const c1 = index.col(hx + r);
  const r0 = index.col(hy - r);
  const r1 = index.col(hy + r);
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const bucket = index.cells[row * index.cols + col];
      if (!bucket) continue;
      for (const f of bucket) {
        const dx = f.x - hx;
        const dy = f.y - hy;
        const d2 = dx * dx + dy * dy;
        if (d2 <= r2) near.push({ food: f, d2 });
      }
    }
  }
  near.sort((a, b) => a.d2 - b.d2 || a.food.id - b.food.id);
  if (near.length > c.visionMaxFood) near.length = Math.max(0, c.visionMaxFood);
  const food: FoodView[] = near.map(({ food: f }) => ({ x: f.x, y: f.y, value: f.value }));

  const all = me.segments.map((_, k) => k);
  const selfSegments = evenlySpaced(all, Math.max(1, c.visionMaxSelfSegments));
  return {
    tick: world.tick,
    lifeTick: me.lifeTick,
    self: {
      id: me.id,
      head: point(me.head),
      angle: me.angle,
      length: me.mass,
      speed: me.speed,
      radius: me.size / 2,
      turnRate: c.turnRate,
      boosting: me.boosting,
      segments: selfSegments.map((k) => point(me.segments[k] as Vec2)),
    },
    snakes,
    food,
    wallDistance: c.arenaRadius - Math.sqrt(hx * hx + hy * hy),
  };
}

function point(p: Vec2): Vec {
  return { x: p.x, y: p.y };
}

/** `count` items of `items` (all if it has no more), evenly spaced, first and last included. */
function evenlySpaced<T>(items: readonly T[], count: number): T[] {
  const n = items.length;
  if (count >= n) return items.slice();
  if (count <= 1) return n > 0 && count === 1 ? [items[0] as T] : [];
  const out: T[] = new Array(count);
  // Steps of (n - 1) / (count - 1) ≥ 1, so the rounded indices are distinct.
  for (let j = 0; j < count; j++) out[j] = items[Math.round((j * (n - 1)) / (count - 1))] as T;
  return out;
}
