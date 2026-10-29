import { describe, expect, it } from "vitest";
import type { EngineConfig } from "./config.ts";
import { hashWorld } from "./hash.ts";
import { cos, sin, squareNorm, TAU, wrapAngle } from "./math.ts";
import { ReplayPlayer, ReplayRecorder } from "./replay.ts";
import { createRng } from "./rng.ts";
import { step } from "./step.ts";
import { actionsFor, farm, type Policy, wander } from "./testing/policies.ts";
import { fromBase64, PRE_102_CHUNKS, PRE_102_END } from "./testing/pre-102.ts";
import { place, QUIET } from "./testing/setup.ts";
import type { Snake, World } from "./types.ts";
import { buildBotState } from "./vision.ts";
import { cloneWorld, createWorld, spawnSnake } from "./world.ts";

/** A world as saved before #102: no spawnCandidates, no spawnGraceTicks. */
function preSafeSpawn(world: World): World {
  const config: Partial<EngineConfig> = world.config;
  delete config.spawnCandidates;
  delete config.spawnGraceTicks;
  return world;
}

/** `n` long snakes (mass 300, ~35 units) at random poses in the spawn square. */
function crowd(seed: number, n: number, config: Partial<EngineConfig> = {}): World {
  const world = createWorld({ seed, config: { ...QUIET, ...config } });
  const rng = createRng(seed);
  const h = world.config.arenaHalfSize * 0.8;
  for (let i = 0; i < n; i++) {
    const x = rng.range(-h, h);
    const y = rng.range(-h, h);
    place(world, { id: `c${i}`, x, y, angle: rng.range(-Math.PI, Math.PI), mass: 300 });
  }
  for (const s of world.snakes) s.lifeTick = 100;
  return world;
}

/** Gap from the newborn's head circle to the nearest other body circle (head included). */
function bodyGap(world: World, me: Snake): number {
  let gap = Number.POSITIVE_INFINITY;
  for (const s of world.snakes) {
    if (s === me) continue;
    for (const p of s.segments) {
      const d = Math.hypot(p.x - me.head.x, p.y - me.head.y) - (s.size + me.size) / 2;
      gap = Math.min(gap, d);
    }
  }
  return gap;
}

/** Gap from the newborn's head to the roads other heads drive over the next 2 s. */
function roadGap(world: World, me: Snake): number {
  let gap = Number.POSITIVE_INFINITY;
  for (const s of world.snakes) {
    if (s === me) continue;
    for (let t = 0; t <= 20; t += 0.25) {
      const x = s.head.x + cos(s.angle) * s.speed * t;
      const y = s.head.y + sin(s.angle) * s.speed * t;
      gap = Math.min(gap, Math.hypot(x - me.head.x, y - me.head.y) - (s.size + me.size) / 2);
    }
  }
  return gap;
}

/** Spawns one snake, measures it, and takes it out again. */
function trySpawn(world: World): { bodyGap: number; roadGap: number; snake: Snake } {
  const snake = spawnSnake(world, { id: "new", author: "n" });
  const result = { bodyGap: bodyGap(world, snake), roadGap: roadGap(world, snake), snake };
  world.snakes.pop();
  return result;
}

describe("spawn spot", () => {
  it("lies in the spawn square, facing the centre or one of the headings around it", () => {
    const world = createWorld({ seed: 5 });
    const c = world.config;
    let corner = false;
    let turned = 0;
    for (let i = 0; i < 200; i++) {
      const s = spawnSnake(world, { id: `s${i}`, author: "a" });
      const { x, y } = s.head;
      expect(squareNorm(x, y)).toBeLessThanOrEqual(c.arenaHalfSize * c.spawnHalfSizeFactor);
      if (Math.hypot(x, y) > c.arenaHalfSize * c.spawnHalfSizeFactor) corner = true;
      const off = wrapAngle(s.angle - Math.atan2(-y, -x)) / (TAU / 16);
      expect(Math.abs(off - Math.round(off))).toBeLessThan(1e-9);
      if (i === 0) expect(Math.abs(off)).toBeLessThan(1e-9);
      if (Math.round(off) !== 0) turned++;
    }
    // Uniform over the square, so the corners beyond the inscribed circle get some.
    expect(corner).toBe(true);
    // 200 snakes in a pile: some had to face away from someone.
    expect(turned).toBeGreaterThan(0);
  });

  it("is what the old spawn picked in an empty arena", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const fresh = createWorld({ seed });
      const old = preSafeSpawn(createWorld({ seed }));
      const a = spawnSnake(fresh, { id: "a", author: "a" });
      const b = spawnSnake(old, { id: "a", author: "a" });
      expect(a).toEqual(b);
      expect(fresh.rng).toEqual(old.rng);
    }
  });

  it("keeps spawnClearance from bodies and heads' roads when there is room for it", () => {
    let oldTooClose = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const world = crowd(seed, 6);
      const old = preSafeSpawn(cloneWorld(world));
      for (let k = 0; k < 20; k++) {
        const s = trySpawn(world);
        expect(Math.min(s.bodyGap, s.roadGap)).toBeGreaterThanOrEqual(world.config.spawnClearance);
        const o = trySpawn(old);
        if (Math.min(o.bodyGap, o.roadGap) < world.config.spawnClearance) oldTooClose++;
      }
    }
    // The old spawn looked at body points only. (154 of 200 had room when this was written.)
    expect(oldTooClose).toBeGreaterThan(20);
  });

  it("never touches a body or a head's road, even in a packed arena", () => {
    let fresh = 0;
    let old = 0;
    let oldTouching = 0;
    for (let seed = 1; seed <= 10; seed++) {
      // 80 snakes of ~35 units: nowhere has spawnClearance of room, so the roomiest try wins.
      const world = crowd(seed, 80);
      const before = preSafeSpawn(cloneWorld(world));
      for (let k = 0; k < 20; k++) {
        const s = trySpawn(world);
        const o = trySpawn(before);
        expect(Math.min(s.bodyGap, s.roadGap)).toBeGreaterThan(0);
        const c = world.config;
        expect(squareNorm(s.snake.head.x, s.snake.head.y)).toBeLessThanOrEqual(
          c.arenaHalfSize * c.spawnHalfSizeFactor,
        );
        fresh += Math.min(s.bodyGap, s.roadGap);
        old += Math.min(o.bodyGap, o.roadGap);
        if (Math.min(o.bodyGap, o.roadGap) < 0) oldTouching++;
      }
    }
    expect(oldTouching).toBeGreaterThan(0);
    expect(fresh).toBeGreaterThan(old * 1.5);
  });

  it("faces the open side", () => {
    // Bodies above, below and behind (−x) a point near the origin; open towards +x.
    const world = createWorld({ seed: 3, config: { ...QUIET, spawnHalfSizeFactor: 0.001 } });
    place(world, { id: "up", x: -15, y: 6, angle: Math.PI, mass: 300 });
    place(world, { id: "down", x: -15, y: -6, angle: Math.PI, mass: 300 });
    place(world, { id: "back", x: -6, y: -15, angle: -Math.PI / 2, mass: 300 });
    for (let k = 0; k < 10; k++) {
      const s = spawnSnake(world, { id: "new", author: "n" });
      expect(Math.abs(s.angle)).toBeLessThanOrEqual(TAU / 16 + 1e-9);
      world.snakes.pop();
    }
  });

  it("is deterministic", () => {
    const a = crowd(7, 30);
    const b = cloneWorld(a);
    for (let k = 0; k < 10; k++) {
      spawnSnake(a, { id: `n${k}`, author: "n" });
      spawnSnake(b, { id: `n${k}`, author: "n" });
    }
    expect(hashWorld(a)).toBe(hashWorld(b));
  });

  it("keeps the old spawn for worlds saved before it", () => {
    const old = preSafeSpawn(createWorld({ seed: 5 }));
    const zero = createWorld({ seed: 5, config: { spawnCandidates: 0, spawnGraceTicks: 0 } });
    for (let i = 0; i < 200; i++) {
      const a = spawnSnake(old, { id: `s${i}`, author: "a" });
      const b = spawnSnake(zero, { id: `s${i}`, author: "a" });
      expect(a).toEqual(b);
      expect(Math.abs(wrapAngle(a.angle - Math.atan2(-a.head.y, -a.head.x)))).toBeLessThan(1e-12);
    }
  });
});

describe("spawn grace in vision", () => {
  it("counts down from spawnGraceTicks, for the snake itself and for others", () => {
    const world = createWorld({ seed: 2, config: QUIET });
    const grace = world.config.spawnGraceTicks;
    const old = place(world, { id: "old", x: 0, y: 0, angle: 0 });
    old.lifeTick = 100;
    place(world, { id: "new", x: 10, y: 0, angle: 0 });
    for (let t = 0; t <= grace + 1; t++) {
      const mine = buildBotState(world, "new");
      expect(mine.self.spawnGrace).toBe(Math.max(0, grace - t));
      const theirs = buildBotState(world, "old");
      expect(theirs.self.spawnGrace).toBe(0);
      expect(theirs.snakes.find((s) => s.id === "new")?.spawnGrace).toBe(Math.max(0, grace - t));
      step(world, {});
    }
  });

  it("is 0 in worlds saved before it", () => {
    const world = preSafeSpawn(createWorld({ seed: 2, config: QUIET }));
    place(world, { id: "a", x: 0, y: 0, angle: 0 });
    expect(buildBotState(world, "a").self.spawnGrace).toBe(0);
  });
});

describe("replays", () => {
  it("plays a room recorded before #102 back exactly", () => {
    // Its snakes spawned into the crowd as others died, the old way; with no spawnCandidates
    // and spawnGraceTicks in its config they still do, and every recorded hash matches.
    const player = new ReplayPlayer(PRE_102_CHUNKS.map(fromBase64));
    expect(player.world.config.spawnGraceTicks).toBeUndefined();
    let deaths = 0;
    for (let t = player.startTick + 1; t <= player.endTick; t++) {
      deaths += player.seek(t).deaths.length;
    }
    expect(player.world.tick).toBe(PRE_102_END.tick);
    expect(hashWorld(player.world)).toBe(PRE_102_END.hash);
    expect(deaths).toBe(PRE_102_END.deaths);
  });

  it("plays a room with spawn grace back exactly", () => {
    const world = createWorld({ seed: 9 });
    const chunks: Uint8Array[] = [];
    const recorder = new ReplayRecorder(world, {
      onChunk: (b) => chunks.push(b),
      chunkTicks: 100,
      hashEvery: 1,
    });
    const policies: Record<string, Policy> = {};
    let lives = 0;
    let newbornDeaths = 0;
    const fill = () => {
      while (world.snakes.length < 14) {
        const id = `s${lives++}`;
        policies[id] = lives % 3 === 0 ? farm : wander(lives);
        recorder.spawn({ id, author: "a" });
      }
    };
    fill();
    for (let t = 0; t < 300; t++) {
      recorder.step(actionsFor(world, policies));
      for (const d of world.deaths)
        if (d.lifeTicks < 15 && d.cause === "collision") newbornDeaths++;
      fill();
    }
    recorder.flush();
    expect(lives).toBeGreaterThan(14);
    expect(newbornDeaths).toBe(0);
    const end = new ReplayPlayer(chunks).seek(world.tick);
    expect(hashWorld(end)).toBe(hashWorld(world));
  });
});
