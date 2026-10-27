import { createConfig, type EngineConfig } from "./config.ts";
import { spawnAmbientFood } from "./food.ts";
import { segmentCountForMass, sizeForMass } from "./growth.ts";
import { atan2, cos, sin } from "./math.ts";
import { rngFromState, seedRngState } from "./rng.ts";
import type { Snake, SnakeId, Vec2, World } from "./types.ts";

export interface CreateWorldOptions {
  seed: number;
  config?: Partial<EngineConfig>;
}

/** An empty arena with `foodBase` ambient pellets. */
export function createWorld({ seed, config }: CreateWorldOptions): World {
  const world: World = {
    config: createConfig(config),
    tick: 0,
    rng: seedRngState(seed),
    snakes: [],
    food: [],
    nextFoodId: 0,
    deaths: [],
  };
  const rng = rngFromState(world.rng);
  for (let i = 0; i < world.config.foodBase; i++) spawnAmbientFood(world, rng);
  return world;
}

export interface SpawnOptions {
  id: SnakeId;
  author: string;
}

/**
 * Starts a new life at a random clear spot, facing the centre, body laid out straight behind
 * it. Part of the replayable input: call it at the same point between steps to reproduce a run.
 */
export function spawnSnake(world: World, { id, author }: SpawnOptions): Snake {
  if (world.snakes.some((s) => s.id === id)) throw new Error(`snake ${id} already exists`);
  const c = world.config;
  const rng = rngFromState(world.rng);
  const seed = rng.int(4294967296);

  let x = 0;
  let y = 0;
  const h = c.arenaHalfSize * c.spawnHalfSizeFactor;
  for (let attempt = 0; attempt < c.spawnAttempts; attempt++) {
    x = rng.range(-h, h);
    y = rng.range(-h, h);
    if (isClear(world, x, y, c.spawnClearance)) break;
  }

  const angle = atan2(-y, -x);
  const mass = c.startMass;
  const size = sizeForMass(mass, c);
  const bodyLength = (segmentCountForMass(mass, c) - 1) * size;
  const snake: Snake = {
    id,
    author,
    seed,
    head: { x, y },
    angle,
    speed: c.speed,
    boosting: false,
    mass,
    size,
    segments: [],
    trail: [
      { x: x - cos(angle) * bodyLength, y: y - sin(angle) * bodyLength },
      { x, y },
    ],
    bornTick: world.tick,
    lifeTick: 0,
    kills: 0,
    maxMass: mass,
    massArea: 0,
    score: 0,
  };
  layoutSegments(snake, segmentCountForMass(mass, c));
  world.snakes.push(snake);
  return snake;
}

function isClear(world: World, x: number, y: number, clearance: number): boolean {
  const c2 = clearance * clearance;
  for (const s of world.snakes) {
    for (const p of s.segments) {
      const dx = p.x - x;
      const dy = p.y - y;
      if (dx * dx + dy * dy < c2) return false;
    }
  }
  return true;
}

/**
 * Places `count` segments `size` apart along the trail, from the head backwards, reusing the
 * existing segment objects. Segments past the end of the trail stack on its oldest point, so a
 * growing snake unfolds from the tail. Prunes trail points the body no longer reaches.
 */
export function layoutSegments(snake: Snake, count: number): void {
  const trail = snake.trail;
  const segs = snake.segments;
  const spacing = snake.size;
  let i = trail.length - 1;
  const head = trail[i] as Vec2;
  let px = head.x;
  let py = head.y;

  if (segs.length > count) segs.length = count;
  while (segs.length < count) segs.push({ x: px, y: py });

  const first = segs[0] as Vec2;
  first.x = px;
  first.y = py;
  snake.head.x = px;
  snake.head.y = py;

  let need = spacing;
  let k = 1;
  while (k < count) {
    if (i === 0) {
      const s = segs[k] as Vec2;
      s.x = px;
      s.y = py;
      k++;
      continue;
    }
    const q = trail[i - 1] as Vec2;
    const dx = q.x - px;
    const dy = q.y - py;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d >= need) {
      const f = need / d;
      px += dx * f;
      py += dy * f;
      const s = segs[k] as Vec2;
      s.x = px;
      s.y = py;
      k++;
      need = spacing;
    } else {
      need -= d;
      px = q.x;
      py = q.y;
      i--;
    }
  }
  // The tail lies between trail[i - 1] and trail[i]; older points are no longer needed.
  if (i > 1) trail.splice(0, i - 1);
}

/** Deep copy. Worlds hold no shared references, so this is a faithful snapshot. */
export function cloneWorld(world: World): World {
  return {
    config: { ...world.config },
    tick: world.tick,
    rng: [...world.rng],
    snakes: world.snakes.map((s) => ({
      ...s,
      head: { ...s.head },
      segments: s.segments.map((p) => ({ x: p.x, y: p.y })),
      trail: s.trail.map((p) => ({ x: p.x, y: p.y })),
    })),
    food: world.food.map((f) => ({ ...f })),
    nextFoodId: world.nextFoodId,
    deaths: world.deaths.map((d) => ({ ...d })),
  };
}
