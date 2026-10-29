import type { BotInfo, BotState, Food as FoodView, SnakeView, Vec } from "@zerosnake/sdk";
import { TICK_RATE } from "./config.ts";
import { foodIndex } from "./food.ts";
import { squareNorm } from "./math.ts";
import { spawnGraceLeft } from "./spawn.ts";
import type { Food, Snake, SnakeId, Vec2, World } from "./types.ts";

/**
 * What a bot sees (SPEC §3): the `BotState` / `BotInfo` of `@zerosnake/sdk`, built from a world.
 *
 * Vision is a disc of `config.visionRadius` around the head: a point is visible when its distance
 * from the head is at most the radius. Only visible points of other snakes and visible pellets
 * reach the state. Its size is capped so copying it into the sandbox stays cheap:
 *  - at most `visionMaxSnakes` other snakes, the nearest (by their nearest visible point);
 *  - at most `visionMaxSegments` body points over all of them. When there are more, each snake
 *    keeps its point nearest the head, and the rest of the budget goes to the nearest remaining
 *    points overall. So bodies are complete (no fake gaps) up to some distance and only the far
 *    parts of the view are cut, where they matter least;
 *  - at most `visionMaxSelfSegments` points of the bot's own body, evenly spaced, head and tail
 *    kept (a snake can't collide with itself, so gaps there are harmless);
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
    worldHalfSize: c.arenaHalfSize,
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
  /** Squared distance of each visible segment, same order. */
  dist2: number[];
  /** Position in `visible` of the nearest one. */
  nearest: number;
  /** Its squared distance. */
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
    const dist2: number[] = [];
    let nearest = 0;
    const segs = other.segments;
    for (let k = 0; k < segs.length; k++) {
      const p = segs[k] as Vec2;
      const dx = p.x - hx;
      const dy = p.y - hy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      if (d2 < (dist2[nearest] ?? Number.POSITIVE_INFINITY)) nearest = visible.length;
      visible.push(k);
      dist2.push(d2);
    }
    if (visible.length > 0) {
      const d2 = dist2[nearest] as number;
      seen.push({ snake: other, visible, dist2, nearest, d2, order: i });
    }
  }
  seen.sort((a, b) => a.d2 - b.d2 || a.order - b.order);
  const maxSnakes = Math.max(0, Math.min(c.visionMaxSnakes, c.visionMaxSegments));
  if (seen.length > maxSnakes) seen = seen.slice(0, maxSnakes);

  const kept = keepNearest(seen, c.visionMaxSegments);
  const snakes: SnakeView[] = seen.map(({ snake: other, visible }, s) => {
    const headVisible = visible[0] === 0;
    return {
      id: other.id,
      author: other.author,
      length: other.mass,
      radius: other.size / 2,
      head: headVisible ? point(other.head) : null,
      angle: headVisible ? other.angle : null,
      boosting: other.boosting,
      spawnGrace: spawnGraceLeft(other, c),
      segments: (kept[s] ?? visible).map((k) => point(other.segments[k] as Vec2)),
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
      spawnGrace: spawnGraceLeft(me, c),
      segments: selfSegments.map((k) => point(me.segments[k] as Vec2)),
    },
    snakes,
    food,
    wallDistance: c.arenaHalfSize - squareNorm(hx, hy),
  };
}

/**
 * Segment indices to keep per snake (head to tail) when the visible points exceed `budget`, or
 * an empty list when they all fit. Each snake keeps its nearest point; the remaining budget goes
 * to the nearest of all other points (ties by snake, then head to tail).
 */
function keepNearest(seen: readonly Seen[], budget: number): number[][] {
  let total = 0;
  for (const v of seen) total += v.visible.length;
  if (total <= budget) return [];
  const rest: { d2: number; s: number; j: number }[] = [];
  const keep: boolean[][] = seen.map((v, s) => {
    const flags = new Array<boolean>(v.visible.length).fill(false);
    flags[v.nearest] = true;
    for (let j = 0; j < v.visible.length; j++) {
      if (j !== v.nearest) rest.push({ d2: v.dist2[j] as number, s, j });
    }
    return flags;
  });
  rest.sort((a, b) => a.d2 - b.d2 || a.s - b.s || a.j - b.j);
  const spare = Math.max(0, budget - seen.length);
  for (let q = 0; q < spare && q < rest.length; q++) {
    const p = rest[q] as { s: number; j: number };
    (keep[p.s] as boolean[])[p.j] = true;
  }
  return seen.map((v, s) => v.visible.filter((_, j) => (keep[s] as boolean[])[j]));
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
