import type { EngineConfig } from "./config.ts";
import { atan2, cos, sin, squareNorm, TAU, wrapAngle } from "./math.ts";
import type { Rng } from "./rng.ts";
import type { Snake, World } from "./types.ts";

/**
 * Where a new life starts (#102). The old spawn took the first random point 10 units from every
 * body point, ignoring heads, so a fresh body could land right across another snake's path. Now:
 *
 *  - up to `spawnCandidates` random points in the spawn square are scored by their **room**: the
 *    gap from a newborn's body circle to the nearest threat. Threats are other snakes' body
 *    points, their heads (padded by `HEAD_REACH` ticks of movement, since a head can turn toward
 *    you), and the road each head drives over the next `LOOK_AHEAD` ticks on its current heading.
 *    The first point with `spawnClearance` of room is taken, else the roomiest;
 *  - the heading is the one of `HEADINGS` whose straight road over `LOOK_AHEAD` ticks keeps the
 *    most room (the wall counts too), capped at `spawnClearance` so that in open space the snake
 *    faces the centre as before.
 *
 * Deterministic (the world PRNG draws the points) and bounded: a threat list of every body point
 * plus `LOOK_AHEAD / ROAD_STEP + 1` points per head, scanned once per candidate; headings only
 * look at threats near the chosen point. In an empty arena it picks what the old spawn did.
 */

/** Ticks of road looked at: other heads' and the newborn's own (2 s). */
const LOOK_AHEAD = 20;
/** Ticks between the points a road is sampled at. */
const ROAD_STEP = 2;
/** A head counts as close as this many ticks of its own movement nearer than it is. */
const HEAD_REACH = 5;
/** How much a head's road widens per unit of its length (it may turn). */
const ROAD_SPREAD = 0.1;
/** Initial headings tried, evenly spaced. */
const HEADINGS = 16;

export interface SpawnPoint {
  x: number;
  y: number;
  angle: number;
}

/** Where a snake of radius `radius` spawns, drawing from `rng`. */
export function spawnPoint(world: World, rng: Rng, radius: number): SpawnPoint {
  const c = world.config;
  return c.spawnCandidates > 0 ? safeSpawn(world, rng, radius) : oldSpawn(world, rng);
}

/** Ticks of spawn grace `snake` has left, the coming step included (0 when it has none). */
export function spawnGraceLeft(
  snake: Pick<Snake, "lifeTick">,
  c: Pick<EngineConfig, "spawnGraceTicks">,
): number {
  // Worlds saved before #102 have no spawnGraceTicks.
  const grace = c.spawnGraceTicks ?? 0;
  return snake.lifeTick < grace ? grace - snake.lifeTick : 0;
}

/** The spawn of worlds without `spawnCandidates`, unchanged so their replays still play. */
function oldSpawn(world: World, rng: Rng): SpawnPoint {
  const c = world.config;
  let x = 0;
  let y = 0;
  const h = c.arenaHalfSize * c.spawnHalfSizeFactor;
  for (let attempt = 0; attempt < c.spawnAttempts; attempt++) {
    x = rng.range(-h, h);
    y = rng.range(-h, h);
    if (isClear(world, x, y, c.spawnClearance)) break;
  }
  return { x, y, angle: atan2(-y, -x) };
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
 * Threat points: room at (x, y) is min(distance − pad) over the first `n`. Reused between spawns
 * (a spawn in a full room looks at hundreds); they never carry state from one to the next.
 */
class Threats {
  n = 0;
  x = new Float64Array(256);
  y = new Float64Array(256);
  pad = new Float64Array(256);

  push(x: number, y: number, pad: number): void {
    if (this.n === this.x.length) {
      const grow = (a: Float64Array) => {
        const b = new Float64Array(a.length * 2);
        b.set(a);
        return b;
      };
      this.x = grow(this.x);
      this.y = grow(this.y);
      this.pad = grow(this.pad);
    }
    this.x[this.n] = x;
    this.y[this.n] = y;
    this.pad[this.n] = pad;
    this.n++;
  }
}

const allThreats = new Threats();
const nearThreats = new Threats();
const roadThreats = new Threats();

function safeSpawn(world: World, rng: Rng, radius: number): SpawnPoint {
  const c = world.config;
  const threats = threatsOf(world, radius);
  const enough = c.spawnClearance;
  const h = c.arenaHalfSize * c.spawnHalfSizeFactor;

  let bestX = 0;
  let bestY = 0;
  let best = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < c.spawnCandidates; k++) {
    const x = rng.range(-h, h);
    const y = rng.range(-h, h);
    const room = roomAt(threats, x, y, enough);
    if (room > best) {
      best = room;
      bestX = x;
      bestY = y;
    }
    if (room >= enough) break;
  }
  return { x: bestX, y: bestY, angle: openHeading(world, threats, bestX, bestY, radius) };
}

function threatsOf(world: World, radius: number): Threats {
  const t = allThreats;
  t.n = 0;
  for (const s of world.snakes) {
    const r = radius + s.size / 2;
    const segs = s.segments;
    for (let k = 1; k < segs.length; k++) {
      const p = segs[k] as { x: number; y: number };
      t.push(p.x, p.y, r);
    }
    const dx = cos(s.angle) * s.speed;
    const dy = sin(s.angle) * s.speed;
    t.push(s.head.x, s.head.y, r + HEAD_REACH * s.speed);
    for (let tick = ROAD_STEP; tick <= LOOK_AHEAD; tick += ROAD_STEP) {
      t.push(s.head.x + dx * tick, s.head.y + dy * tick, r + ROAD_SPREAD * s.speed * tick);
    }
  }
  return t;
}

/** Room at (x, y), or anything ≥ `enough` once it is known to be at least that. */
function roomAt(t: Threats, x: number, y: number, enough: number): number {
  let room = Number.POSITIVE_INFINITY;
  for (let i = 0; i < t.n; i++) {
    const pad = t.pad[i] as number;
    const dx = (t.x[i] as number) - x;
    const dy = (t.y[i] as number) - y;
    // Skip the square root for threats farther than room + pad on one axis alone.
    const far = Math.min(room, enough) + pad;
    if (dx > far || dx < -far || dy > far || dy < -far) continue;
    const gap = Math.sqrt(dx * dx + dy * dy) - pad;
    if (gap < room) room = gap;
  }
  return room;
}

/**
 * The heading with the most room along its straight road over `LOOK_AHEAD` ticks, capped at
 * `spawnClearance`; ties go to the one nearest to facing the centre.
 */
function openHeading(world: World, all: Threats, x: number, y: number, radius: number): number {
  const c = world.config;
  const enough = c.spawnClearance;
  const toCentre = atan2(-y, -x);
  const road = c.speed * LOOK_AHEAD;
  // Only threats that could come within `enough` of the road matter.
  const near = nearThreats;
  near.n = 0;
  for (let i = 0; i < all.n; i++) {
    const dx = (all.x[i] as number) - x;
    const dy = (all.y[i] as number) - y;
    const reach = road + enough + (all.pad[i] as number);
    if (dx * dx + dy * dy > reach * reach) continue;
    near.push(all.x[i] as number, all.y[i] as number, all.pad[i] as number);
  }

  let bestAngle = toCentre;
  let best = Number.NEGATIVE_INFINITY;
  // 0, +1, −1, +2, −2, … steps from facing the centre.
  for (let k = 0; k < HEADINGS; k++) {
    const offset = ((k + 1) >> 1) * (k % 2 === 1 ? 1 : -1);
    const angle = k === 0 ? toCentre : wrapAngle(toCentre + (offset * TAU) / HEADINGS);
    const ux = cos(angle);
    const uy = sin(angle);
    // Of those, only threats beside this heading's road can come within `enough` of it (with a
    // hair of slack, so dropping the others changes no result).
    const beside = roadThreats;
    beside.n = 0;
    for (let i = 0; i < near.n; i++) {
      const ox = (near.x[i] as number) - x;
      const oy = (near.y[i] as number) - y;
      const reach = enough + (near.pad[i] as number) + 1e-6;
      const along = ox * ux + oy * uy;
      if (along < ROAD_STEP * c.speed - reach || along > road + reach) continue;
      if (Math.abs(oy * ux - ox * uy) > reach) continue;
      beside.push(near.x[i] as number, near.y[i] as number, near.pad[i] as number);
    }
    const dx = ux * c.speed;
    const dy = uy * c.speed;
    let room = enough;
    for (let tick = ROAD_STEP; tick <= LOOK_AHEAD && room > best; tick += ROAD_STEP) {
      const px = x + dx * tick;
      const py = y + dy * tick;
      const wall = c.arenaHalfSize - squareNorm(px, py) - radius;
      room = Math.min(room, wall, roomAt(beside, px, py, room));
    }
    if (room > best) {
      best = room;
      bestAngle = angle;
    }
    if (best >= enough) break;
  }
  return bestAngle;
}
