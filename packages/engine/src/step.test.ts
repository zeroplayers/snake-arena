import { describe, expect, it } from "vitest";
import { createRng } from "./rng.ts";
import { step } from "./step.ts";
import { fingerprint } from "./testing/fingerprint.ts";
import { actionsFor, farm, type Policy, wander } from "./testing/policies.ts";
import { place, QUIET } from "./testing/setup.ts";
import type { World } from "./types.ts";
import { cloneWorld, createWorld, spawnSnake } from "./world.ts";

/** 20 snakes, dead ones respawned under a new id. Farmers are slow (full food scan), so optional. */
function run(seed: number, ticks: number, farmers = true): World {
  const world = createWorld({ seed });
  const policies: Record<string, Policy> = {};
  let lives = 0;
  const fill = () => {
    while (world.snakes.length < 20) {
      const id = `s${lives++}`;
      policies[id] = farmers && lives % 3 === 0 ? farm : wander(seed * 1000 + lives);
      spawnSnake(world, { id, author: `author${lives % 7}` });
    }
  };
  fill();
  for (let t = 0; t < ticks; t++) {
    step(world, actionsFor(world, policies));
    fill();
  }
  return world;
}

describe("movement", () => {
  it("moves the head `speed` units along its heading", () => {
    const world = createWorld({ seed: 1, config: QUIET });
    const s = place(world, { id: "a", x: 0, y: 0, angle: 0 });
    step(world, { a: { turn: 0 } });
    expect(s.head.x).toBeCloseTo(world.config.speed, 12);
    expect(s.head.y).toBeCloseTo(0, 12);
    expect(s.segments[0]).toEqual(s.head);
  });

  it("limits turning to turnRate per tick and clamps the input", () => {
    const world = createWorld({ seed: 1, config: QUIET });
    const s = place(world, { id: "a", x: 0, y: 0, angle: 0 });
    const rate = world.config.turnRate;
    step(world, { a: { turn: 1 } });
    expect(s.angle).toBeCloseTo(-rate, 12);
    step(world, { a: { turn: -50 } });
    expect(s.angle).toBeCloseTo(0, 12);
    step(world, { a: { turn: 0.5 } });
    expect(s.angle).toBeCloseTo(-rate / 2, 12);
    step(world, { a: { turn: Number.NaN } });
    expect(s.angle).toBeCloseTo(-rate / 2, 12);
  });

  it("keeps segments `size` apart along the body", () => {
    const world = createWorld({ seed: 1, config: QUIET });
    const s = place(world, { id: "a", x: 0, y: 0, angle: 0, mass: 500 });
    for (let t = 0; t < 40; t++) step(world, { a: { turn: 0.4 } });
    for (let k = 1; k < s.segments.length; k++) {
      const a = s.segments[k - 1];
      const b = s.segments[k];
      if (!a || !b) throw new Error("missing segment");
      // Chords of an arc are a hair shorter than the arc length.
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(s.size * 0.99);
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThanOrEqual(s.size + 1e-9);
    }
  });

  it("boost doubles speed, burns mass and drops it at the tail", () => {
    const world = createWorld({ seed: 1, config: QUIET });
    const s = place(world, { id: "a", x: 0, y: 0, angle: 0, mass: 50 });
    const tail = { ...s.segments[s.segments.length - 1] };
    step(world, { a: { turn: 0, boost: true } });
    const c = world.config;
    expect(s.boosting).toBe(true);
    expect(s.head.x).toBeCloseTo(c.speed * c.boostMultiplier, 12);
    expect(s.mass).toBe(50 - c.boostCost);
    expect(world.food).toEqual([{ id: 0, ...tail, value: c.boostCost, kind: "boost" }]);
  });

  it("refuses boost below boostMinMass", () => {
    const world = createWorld({ seed: 1, config: QUIET });
    const s = place(world, { id: "a", x: 0, y: 0, angle: 0, mass: 1 });
    step(world, { a: { turn: 0, boost: true } });
    expect(s.boosting).toBe(false);
    expect(s.mass).toBe(1);
    expect(world.food).toHaveLength(0);
  });
});

describe("food", () => {
  it("starts with foodBase pellets and tops up towards the target", () => {
    const world = createWorld({ seed: 3 });
    const c = world.config;
    expect(world.food).toHaveLength(c.foodBase);
    spawnSnake(world, { id: "a", author: "a" });
    step(world, {});
    expect(world.food.length).toBe(c.foodBase + c.foodSpawnPerTick);
    // Circling keeps it away from the wall.
    for (let t = 0; t < 100; t++) step(world, { a: { turn: 1 } });
    expect(world.food.length).toBe(c.foodBase + c.foodPerSnake);
    for (const f of world.food) {
      expect(Math.max(Math.abs(f.x), Math.abs(f.y))).toBeLessThan(c.arenaHalfSize);
    }
  });

  it("eats pellets in the forward cone and grows", () => {
    const world = createWorld({ seed: 1, config: QUIET });
    const s = place(world, { id: "a", x: 0, y: 0, angle: 0 });
    world.food.push({ id: 100, x: 3, y: 0, value: 5, kind: "ambient" });
    world.food.push({ id: 101, x: -2, y: 0, value: 5, kind: "ambient" });
    step(world, { a: { turn: 0 } });
    expect(world.food.map((f) => f.id)).toEqual([101]);
    expect(s.mass).toBe(world.config.startMass + 5);
  });

  it("gives a contested pellet to the nearer head", () => {
    const world = createWorld({ seed: 1, config: QUIET });
    const a = place(world, { id: "a", x: 0, y: 0, angle: 0 });
    const b = place(world, { id: "b", x: 6, y: 0, angle: Math.PI });
    // After one tick the heads are at (1.5, 0) and (4.5, 0); both reach both pellets.
    world.food.push({ id: 100, x: 2.5, y: 0.5, value: 3, kind: "ambient" });
    world.food.push({ id: 101, x: 3.8, y: -0.5, value: 5, kind: "ambient" });
    step(world, {});
    expect(world.food).toHaveLength(0);
    expect(a.mass).toBe(13);
    expect(b.mass).toBe(15);
  });
});

describe("determinism", () => {
  it("same seed and actions give bit-identical worlds", () => {
    const a = run(7, 1500);
    const b = run(7, 1500);
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(a).toEqual(b);
    expect(fingerprint(run(8, 1500))).not.toBe(fingerprint(a));
  });

  it("a clone or a JSON round-trip resumes identically", () => {
    const base = run(11, 300);
    const clone = cloneWorld(base);
    const json = JSON.parse(JSON.stringify(base)) as World;
    expect(fingerprint(clone)).toBe(fingerprint(base));

    const rng = createRng(5);
    const actions = Array.from({ length: 200 }, () =>
      Object.fromEntries(base.snakes.map((s) => [s.id, { turn: rng.range(-1, 1) }])),
    );
    for (const w of [base, clone, json]) for (const act of actions) step(w, act);
    expect(fingerprint(clone)).toBe(fingerprint(base));
    expect(fingerprint(json)).toBe(fingerprint(base));
  });
});

describe("performance", () => {
  // Random walkers die every couple of ticks, so this also covers respawns and lots of remains.
  it("10,000 ticks × 20 snakes in under a second", () => {
    run(1, 500, false); // warm up the JIT
    const t0 = Date.now();
    const world = run(2, 10_000, false);
    const ms = Date.now() - t0;
    expect(world.tick).toBe(10_000);
    expect(world.snakes).toHaveLength(20);
    expect(ms).toBeLessThan(1000);
  });
});
