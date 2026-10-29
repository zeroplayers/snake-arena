import { addFood, foodIndex, removeFood, spawnAmbientFood } from "./food.ts";
import { Grid } from "./grid.ts";
import { hungerDecay, lifeScore, segmentCountForMass, sizeForMass } from "./growth.ts";
import { clamp, cos, exitTime, firstContact, sin, squareNorm, wrapAngle } from "./math.ts";
import { type Rng, rngFromState } from "./rng.ts";
import { spawnGraceLeft } from "./spawn.ts";
import type { ActionMap, Death, DeathCause, FaultMap, Food, Snake, Vec2, World } from "./types.ts";
import { layoutSegments } from "./world.ts";

/**
 * Advances the world by one tick **in place** and returns it (use `cloneWorld` to keep a
 * snapshot). Deterministic: the same world, actions and faults always give the same result.
 *
 * Order within a tick:
 *  1. faults (`timeout` / `error` from the sandbox) kill the snake where it stands;
 *  2. every other snake turns, boosts (burning mass, dropping food at the tail), moves, pays
 *     hunger and re-lays its body;
 *  3. collisions are resolved simultaneously on the new positions — the earliest thing a head
 *     touches during its move wins: another head (smaller mass dies, equal both die), another
 *     body (`collision`, credited to its owner), or the wall. Snakes in spawn grace
 *     (`spawnGraceTicks`) take part only in the wall: no snake kills them, they kill no snake;
 *  4. survivors eat food in their forward cone (a contested pellet goes to the nearest head);
 *  5. survivors age and score; those at `lifeCap` (the 24-hour safety cap) retire;
 *  6. the dead are credited, drop remains and leave; ambient food tops up.
 */
export function step(world: World, actions: ActionMap = {}, faults: FaultMap = {}): World {
  const c = world.config;
  const rng = rngFromState(world.rng);
  const snakes = world.snakes;
  const n = snakes.length;
  const s = scratch(n);
  world.tick++;
  world.deaths = [];

  s.deathT.fill(Number.POSITIVE_INFINITY, 0, n);
  s.killer.fill(-1, 0, n);
  const causes: (DeathCause | null)[] = new Array(n).fill(null);
  const die = (i: number, t: number, cause: DeathCause, killer: number) => {
    if (t < (s.deathT[i] as number)) {
      s.deathT[i] = t;
      causes[i] = cause;
      s.killer[i] = killer;
    }
  };

  // 1–2. Faults, then movement.
  for (let i = 0; i < n; i++) {
    const snake = snakes[i] as Snake;
    const head = snake.head;
    s.x0[i] = head.x;
    s.y0[i] = head.y;
    const fault = faults[snake.id];
    if (fault) {
      die(i, -1, fault, -1);
      s.dirX[i] = cos(snake.angle);
      s.dirY[i] = sin(snake.angle);
      continue;
    }

    const action = actions[snake.id];
    const turn = quantizeTurn(action?.turn) / TURN_STEPS;
    snake.angle = wrapAngle(snake.angle - turn * c.turnRate);
    const dx = cos(snake.angle);
    const dy = sin(snake.angle);
    s.dirX[i] = dx;
    s.dirY[i] = dy;

    const boost = action?.boost === true && snake.mass >= c.boostMinMass;
    snake.boosting = boost;
    snake.speed = boost ? c.speed * c.boostMultiplier : c.speed;
    snake.trail.push({ x: head.x + dx * snake.speed, y: head.y + dy * snake.speed });

    if (boost) {
      const burn = Math.min(c.boostCost, snake.mass - c.minMass);
      snake.mass -= burn;
      const drop = burn * c.boostDropRatio;
      const tail = snake.segments[snake.segments.length - 1] as Vec2;
      if (drop > 0 && world.food.length < c.maxFood) addFood(world, tail.x, tail.y, drop, "boost");
    }
    snake.mass = hungerDecay(snake.mass, c);
    snake.size = sizeForMass(snake.mass, c);
    layoutSegments(snake, segmentCountForMass(snake.mass, c));
  }

  // 3. Collisions.
  resolveCollisions(world, s, die);
  const arena = c.arenaHalfSize;
  for (let i = 0; i < n; i++) {
    const head = (snakes[i] as Snake).head;
    if (squareNorm(head.x, head.y) > arena) {
      const x0 = s.x0[i] as number;
      const y0 = s.y0[i] as number;
      die(i, exitTime(x0, y0, head.x - x0, head.y - y0, arena), "wall", -1);
    }
  }

  // 4. Eating.
  eat(world, s);

  // 5. Ageing, score, retirement.
  for (let i = 0; i < n; i++) {
    if (causes[i] !== null) continue;
    const snake = snakes[i] as Snake;
    snake.lifeTick++;
    if (snake.mass > snake.maxMass) snake.maxMass = snake.mass;
    snake.massArea += snake.mass;
    snake.score = lifeScore(snake.massArea, snake.kills, c);
    if (snake.lifeTick >= c.lifeCap) die(i, 2, "retired", -1);
  }

  // 6. Deaths, then ambient food.
  let anyDead = false;
  for (let i = 0; i < n; i++) {
    const k = s.killer[i] as number;
    if (causes[i] === null) continue;
    anyDead = true;
    if (k >= 0) {
      const killer = snakes[k] as Snake;
      killer.kills++;
      killer.score = lifeScore(killer.massArea, killer.kills, c);
    }
  }
  if (anyDead) {
    for (let i = 0; i < n; i++) {
      const cause = causes[i];
      if (cause == null) continue;
      const snake = snakes[i] as Snake;
      const killer = (s.killer[i] as number) >= 0 ? (snakes[s.killer[i] as number] as Snake) : null;
      world.deaths.push(deathRecord(world, snake, cause, killer));
      dropRemains(world, snake, rng);
    }
    world.snakes = snakes.filter((_, i) => causes[i] === null);
  }

  const target = Math.min(c.maxFood, c.foodBase + c.foodPerSnake * world.snakes.length);
  const spawn = Math.min(c.foodSpawnPerTick, target - world.food.length);
  for (let k = 0; k < spawn; k++) spawnAmbientFood(world, rng);

  return world;
}

/**
 * Turn input is rounded to a multiple of 1 / TURN_STEPS, so a replay can store each turn exactly
 * in a byte or so instead of a float64 (#9). 0.5, 0.25 and the like stay exact.
 */
export const TURN_STEPS = 128;

/**
 * The integer in [-TURN_STEPS, TURN_STEPS] that `step` turns by (in units of
 * turnRate / TURN_STEPS): clamped to [-1, 1], NaN and non-numbers as 0, never -0.
 */
export function quantizeTurn(turn: unknown): number {
  return Math.round(clamp(Number(turn) || 0, -1, 1) * TURN_STEPS) | 0;
}

type Die = (i: number, t: number, cause: DeathCause, killer: number) => void;

/**
 * Head × head contacts first (they shadow body hits between the same pair), then head × body.
 * A snake in spawn grace is left out of both: its head hits nothing, its body isn't solid.
 */
function resolveCollisions(world: World, s: Scratch, die: Die): void {
  const snakes = world.snakes;
  const n = snakes.length;
  const contact = s.contact;
  contact.fill(0, 0, n * n);
  const ghost = s.ghost;

  let maxSize = 0;
  for (let i = 0; i < n; i++) {
    const snake = snakes[i] as Snake;
    if (snake.size > maxSize) maxSize = snake.size;
    ghost[i] = spawnGraceLeft(snake, world.config) > 0 ? 1 : 0;
  }

  for (let i = 0; i < n; i++) {
    if (ghost[i] === 1) continue;
    const a = snakes[i] as Snake;
    const ax0 = s.x0[i] as number;
    const ay0 = s.y0[i] as number;
    for (let j = i + 1; j < n; j++) {
      if (ghost[j] === 1) continue;
      const b = snakes[j] as Snake;
      const bx0 = s.x0[j] as number;
      const by0 = s.y0[j] as number;
      const vx = a.head.x - ax0 - (b.head.x - bx0);
      const vy = a.head.y - ay0 - (b.head.y - by0);
      const t = firstContact(ax0 - bx0, ay0 - by0, vx, vy, (a.size + b.size) / 2);
      if (t < 0) continue;
      contact[i * n + j] = 1;
      contact[j * n + i] = 1;
      if (a.mass <= b.mass) die(i, t, "collision", j);
      if (b.mass <= a.mass) die(j, t, "collision", i);
    }
  }

  // Bodies (segment 1 onwards) of every snake out of grace, dying or not, into the hash.
  let m = 0;
  for (let i = 0; i < n; i++) if (ghost[i] === 0) m += (snakes[i] as Snake).segments.length - 1;
  s.ensureSegments(m);
  m = 0;
  for (let i = 0; i < n; i++) {
    if (ghost[i] === 1) continue;
    const segs = (snakes[i] as Snake).segments;
    for (let k = 1; k < segs.length; k++) {
      const p = segs[k] as Vec2;
      s.segX[m] = p.x;
      s.segY[m] = p.y;
      s.segOwner[m] = i;
      m++;
    }
  }
  const grid = gridFor(world);
  grid.build(m, s.segX, s.segY);

  for (let i = 0; i < n; i++) {
    if (ghost[i] === 1) continue;
    const a = snakes[i] as Snake;
    const x0 = s.x0[i] as number;
    const y0 = s.y0[i] as number;
    const dx = a.head.x - x0;
    const dy = a.head.y - y0;
    const pad = (a.size + maxSize) / 2;
    const c0 = grid.col(Math.min(x0, a.head.x) - pad);
    const c1 = grid.col(Math.max(x0, a.head.x) + pad);
    const r0 = grid.col(Math.min(y0, a.head.y) - pad);
    const r1 = grid.col(Math.max(y0, a.head.y) + pad);
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const cell = row * grid.cols + col;
        for (let j = grid.first(cell); j >= 0; j = grid.next[j] as number) {
          const o = s.segOwner[j] as number;
          if (o === i || contact[i * n + o] === 1) continue;
          const r = (a.size + (snakes[o] as Snake).size) / 2;
          const t = firstContact(x0 - (s.segX[j] as number), y0 - (s.segY[j] as number), dx, dy, r);
          if (t >= 0) die(i, t, "collision", o);
        }
      }
    }
  }
}

/**
 * Survivors eat pellets in their forward cone; a pellet two heads reach goes to the nearer one
 * (the earlier snake on an exact tie).
 */
function eat(world: World, s: Scratch): void {
  const c = world.config;
  if (world.food.length === 0) return;
  const index = foodIndex(world);
  s.ensureFood(world.food.length);
  const snakes = world.snakes;
  const bigPellet = Math.max(c.foodRadius, c.remainsRadius);
  const claimed: number[] = [];
  for (let i = 0; i < snakes.length; i++) {
    if ((s.deathT[i] as number) !== Number.POSITIVE_INFINITY) continue;
    const snake = snakes[i] as Snake;
    const hx = snake.head.x;
    const hy = snake.head.y;
    const dirX = s.dirX[i] as number;
    const dirY = s.dirY[i] as number;
    const reach = snake.size * c.eatRadiusFactor;
    const pad = reach + bigPellet;
    const c0 = index.col(hx - pad);
    const c1 = index.col(hx + pad);
    const r0 = index.col(hy - pad);
    const r1 = index.col(hy + pad);
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const bucket = index.cells[row * index.cols + col];
        if (!bucket) continue;
        for (const p of bucket) {
          const tx = p.x - hx;
          const ty = p.y - hy;
          const d2 = tx * tx + ty * ty;
          const r = reach + (p.kind === "remains" ? c.remainsRadius : c.foodRadius);
          if (d2 >= r * r) continue;
          if (d2 > 0 && tx * dirX + ty * dirY <= c.eatCone * Math.sqrt(d2)) continue;
          const k = index.slot.get(p) as number;
          const by = s.claimBy[k] as number;
          if (by >= 0 && d2 >= (s.claimD[k] as number)) continue;
          if (by < 0) claimed.push(k);
          s.claimD[k] = d2;
          s.claimBy[k] = i;
        }
      }
    }
  }
  if (claimed.length === 0) return;

  claimed.sort((a, b) => a - b);
  for (const k of claimed) {
    (snakes[s.claimBy[k] as number] as Snake).mass += (world.food[k] as Food).value;
    s.claimBy[k] = -1;
  }
  removeFood(world, claimed);
}

function deathRecord(world: World, snake: Snake, cause: DeathCause, killer: Snake | null): Death {
  return {
    id: snake.id,
    author: snake.author,
    cause,
    killerId: killer?.id ?? null,
    killerAuthor: killer?.author ?? null,
    tick: world.tick,
    lifeTicks: snake.lifeTick,
    mass: snake.mass,
    maxMass: snake.maxMass,
    kills: snake.kills,
    score: snake.score,
  };
}

/**
 * Mass × deathDropRatio as pellets of at most remainsMaxValue (but at least remainsPerSegment
 * per segment, and at most one per segment), spread evenly by length along the body: pellet k
 * of n sits (k + ½)/n of the way from head to tail.
 *
 * A config without `remainsPerSegment` (a world or replay from before #101) gets the old layout:
 * no minimum, pellet k on segment ⌊k × segments / n⌋, so it plays back as it was recorded.
 */
function dropRemains(world: World, snake: Snake, rng: Rng): void {
  const c = world.config;
  const total = snake.mass * c.deathDropRatio;
  if (total <= 0) return;
  const segs = snake.segments;
  const perSegment = c.remainsPerSegment as number | undefined;
  const legacy = perSegment === undefined;
  const least = legacy ? 1 : Math.max(1, Math.ceil(segs.length * perSegment));
  const count = Math.min(segs.length, Math.max(least, Math.ceil(total / c.remainsMaxValue)));
  const value = total / count;
  const jitter = c.remainsJitter * snake.size;
  const limit = c.arenaHalfSize * 0.98;
  let length = 0;
  if (!legacy) for (let i = 1; i < segs.length; i++) length += gap(segs, i);
  // Walks the body once: segment `j` starts the gap holding the next pellet, `at` is its distance.
  let j = 0;
  let at = 0;
  for (let k = 0; k < count; k++) {
    let px: number;
    let py: number;
    if (legacy) {
      const p = segs[Math.floor((k * segs.length) / count)] as Vec2;
      px = p.x;
      py = p.y;
    } else {
      const target = (length * (k + 0.5)) / count;
      while (j + 2 < segs.length && at + gap(segs, j + 1) < target) at += gap(segs, ++j);
      const a = segs[j] as Vec2;
      const b = (segs[j + 1] ?? a) as Vec2;
      const d = j + 1 < segs.length ? gap(segs, j + 1) : 0;
      const f = d > 0 ? Math.min(1, (target - at) / d) : 0;
      px = a.x + (b.x - a.x) * f;
      py = a.y + (b.y - a.y) * f;
    }
    const x = clamp(px + rng.range(-jitter, jitter), -limit, limit);
    const y = clamp(py + rng.range(-jitter, jitter), -limit, limit);
    addFood(world, x, y, value, "remains");
  }
}

/** Distance between segments i − 1 and i. */
function gap(segs: readonly Vec2[], i: number): number {
  const a = segs[i - 1] as Vec2;
  const b = segs[i] as Vec2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// --- Scratch buffers ---------------------------------------------------------------------------
// Reused across steps to avoid per-tick allocation. They never carry state between ticks.

class Scratch {
  x0 = new Float64Array(0);
  y0 = new Float64Array(0);
  dirX = new Float64Array(0);
  dirY = new Float64Array(0);
  deathT = new Float64Array(0);
  killer = new Int32Array(0);
  contact = new Uint8Array(0);
  /** 1 for snakes in spawn grace this tick. */
  ghost = new Uint8Array(0);
  segX = new Float64Array(0);
  segY = new Float64Array(0);
  segOwner = new Int32Array(0);
  claimD = new Float64Array(0);
  /** -1 between ticks; set only for pellets claimed this tick. */
  claimBy = new Int32Array(0);

  ensureSnakes(n: number): void {
    if (this.x0.length >= n) return;
    const cap = Math.max(n, this.x0.length * 2, 32);
    this.x0 = new Float64Array(cap);
    this.y0 = new Float64Array(cap);
    this.dirX = new Float64Array(cap);
    this.dirY = new Float64Array(cap);
    this.deathT = new Float64Array(cap);
    this.killer = new Int32Array(cap);
    this.contact = new Uint8Array(cap * cap);
    this.ghost = new Uint8Array(cap);
  }

  ensureSegments(m: number): void {
    if (this.segX.length >= m) return;
    const cap = Math.max(m, this.segX.length * 2, 256);
    this.segX = new Float64Array(cap);
    this.segY = new Float64Array(cap);
    this.segOwner = new Int32Array(cap);
  }

  ensureFood(f: number): void {
    if (this.claimD.length >= f) return;
    const cap = Math.max(f, this.claimD.length * 2, 256);
    this.claimD = new Float64Array(cap);
    this.claimBy = new Int32Array(cap).fill(-1);
  }
}

const shared = new Scratch();

function scratch(n: number): Scratch {
  shared.ensureSnakes(n);
  return shared;
}

const grids = new Map<string, Grid>();

function gridFor(world: World): Grid {
  const { arenaHalfSize, gridCellSize } = world.config;
  const key = `${arenaHalfSize}:${gridCellSize}`;
  let grid = grids.get(key);
  if (!grid) {
    grid = new Grid(arenaHalfSize + gridCellSize, gridCellSize);
    grids.set(key, grid);
  }
  return grid;
}
