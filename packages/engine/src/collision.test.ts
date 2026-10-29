import { describe, expect, it } from "vitest";
import type { EngineConfig } from "./config.ts";
import { addFood } from "./food.ts";
import { Grid } from "./grid.ts";
import { createRng } from "./rng.ts";
import { step } from "./step.ts";
import { place, QUIET } from "./testing/setup.ts";
import type { Snake, World } from "./types.ts";
import { createWorld } from "./world.ts";

// Placed snakes are newborns: no spawn grace, so they collide from the first tick.
const quiet = (config = {}) =>
  createWorld({ seed: 1, config: { ...QUIET, spawnGraceTicks: 0, ...config } });

const remainsValue = (world: World) =>
  world.food.filter((f) => f.kind === "remains").reduce((sum, f) => sum + f.value, 0);

describe("causes of death", () => {
  it("wall: head leaves the arena", () => {
    const world = quiet();
    const h = world.config.arenaHalfSize;
    place(world, { id: "a", x: h - 1, y: 0, angle: 0, mass: 40 });
    step(world, { a: { turn: 0 } });
    expect(world.snakes).toHaveLength(0);
    expect(world.deaths).toMatchObject([{ id: "a", cause: "wall", killerId: null, tick: 1 }]);
    // Remains are pulled back inside so they can be eaten.
    for (const f of world.food) expect(Math.max(Math.abs(f.x), Math.abs(f.y))).toBeLessThan(h);
  });

  it("collision: head into another body, credited to its owner", () => {
    const world = quiet();
    // b lies along the x axis, head at the origin; a crosses its body from below.
    const b = place(world, { id: "b", author: "bob", x: 0, y: 0, angle: 0, mass: 200 });
    place(world, { id: "a", author: "alice", x: -10, y: -2.5, angle: Math.PI / 2 });
    step(world, {});
    expect(world.deaths).toEqual([]);
    step(world, {});
    expect(world.deaths).toMatchObject([
      { id: "a", author: "alice", cause: "collision", killerId: "b", killerAuthor: "bob" },
    ]);
    expect(world.snakes.map((s) => s.id)).toEqual(["b"]);
    expect(b.kills).toBe(1);
    expect(b.score).toBeCloseTo(b.massArea * world.config.massScoreFactor + world.config.killBonus);
  });

  it("collision: no tunnelling through a body at boost speed", () => {
    const world = quiet();
    place(world, { id: "b", x: 0, y: 0, angle: 0, mass: 200 });
    // Moving 3 units a tick, a's head jumps from y = -1.4 to y = 1.6 across b's body.
    place(world, { id: "a", x: -10, y: -1.4, angle: Math.PI / 2, mass: 50 });
    step(world, { a: { turn: 0, boost: true } });
    expect(world.deaths).toMatchObject([{ id: "a", cause: "collision", killerId: "b" }]);
  });

  it("no self-collision", () => {
    const world = quiet();
    place(world, { id: "a", x: 0, y: 0, angle: 0, mass: 3000 });
    for (let t = 0; t < 200; t++) step(world, { a: { turn: 1 } });
    expect(world.deaths).toEqual([]);
    expect(world.snakes).toHaveLength(1);
  });

  it("head × head: the smaller snake dies, credited to the larger", () => {
    const world = quiet();
    const a = place(world, { id: "a", x: -3, y: 0, angle: 0, mass: 50 });
    place(world, { id: "b", x: 3, y: 0, angle: Math.PI, mass: 20 });
    step(world, {});
    step(world, {});
    expect(world.deaths).toMatchObject([{ id: "b", cause: "collision", killerId: "a" }]);
    expect(world.snakes.map((s) => s.id)).toEqual(["a"]);
    expect(a.kills).toBe(1);
  });

  it("head × head: equal snakes both die, each credited with the other", () => {
    const world = quiet();
    place(world, { id: "a", x: -3, y: 0, angle: 0, mass: 30 });
    place(world, { id: "b", x: 3, y: 0, angle: Math.PI, mass: 30 });
    step(world, {});
    step(world, {});
    expect(world.snakes).toHaveLength(0);
    expect(world.deaths).toMatchObject([
      { id: "a", cause: "collision", killerId: "b", kills: 1 },
      { id: "b", cause: "collision", killerId: "a", kills: 1 },
    ]);
  });

  it("the earliest contact during the move decides", () => {
    // In one fast tick a's head would cross c's body (h - 1.5) and then the wall (x = h).
    const world = quiet({ speed: 6 });
    const h = world.config.arenaHalfSize;
    place(world, { id: "c", x: h - 1.5, y: 3, angle: Math.PI / 2, mass: 200 });
    place(world, { id: "a", x: h - 5, y: 0, angle: 0 });
    step(world, {});
    expect(world.deaths).toMatchObject([{ id: "a", cause: "collision", killerId: "c" }]);
  });

  it("timeout and error: the sandbox's verdict kills before moving", () => {
    const world = quiet();
    const a = place(world, { id: "a", x: 0, y: 0, angle: 0 });
    place(world, { id: "b", x: 0, y: 20, angle: 0 });
    place(world, { id: "c", x: 0, y: -20, angle: 0 });
    step(world, { a: { turn: 1 } }, { a: "timeout", b: "error" });
    expect(world.deaths).toMatchObject([
      { id: "a", cause: "timeout", killerId: null, lifeTicks: 0 },
      { id: "b", cause: "error", killerId: null },
    ]);
    expect(a.head).toEqual({ x: 0, y: 0 });
    expect(world.snakes.map((s) => s.id)).toEqual(["c"]);
  });

  it("retired: the life cap ends a life with its score", () => {
    const world = quiet({ lifeCap: 10 });
    place(world, { id: "a", x: 0, y: 0, angle: 0, mass: 100 });
    for (let t = 0; t < 9; t++) step(world, {});
    expect(world.deaths).toEqual([]);
    step(world, {});
    const [death] = world.deaths;
    expect(death).toMatchObject({ id: "a", cause: "retired", killerId: null, lifeTicks: 10 });
    expect(death?.score).toBeCloseTo(100 * 10 * world.config.massScoreFactor);
  });
});

describe("remains", () => {
  it("a dead snake drops its mass as food along its body", () => {
    const world = quiet();
    place(world, { id: "a", x: 0, y: 0, angle: 0, mass: 137 });
    step(world, {}, { a: "error" });
    expect(remainsValue(world)).toBeCloseTo(137 * world.config.deathDropRatio, 9);
    const pellets = world.food.filter((f) => f.kind === "remains");
    expect(pellets.length).toBe(Math.ceil(137 / world.config.remainsMaxValue));
    for (const f of pellets) expect(f.value).toBeLessThanOrEqual(world.config.remainsMaxValue);
    expect(new Set(pellets.map((f) => Math.round(f.x))).size).toBeGreaterThan(5);
  });

  it("the killer can eat the remains", () => {
    const world = quiet();
    const a = place(world, { id: "a", x: -3, y: 0, angle: 0, mass: 50 });
    place(world, { id: "b", x: 3, y: 0, angle: Math.PI, mass: 20 });
    for (let t = 0; t < 12; t++) step(world, {});
    expect(a.mass).toBeGreaterThan(55);
  });
});

describe("spawn grace", () => {
  /** Grace on (the default); `old` snakes are past it. */
  const graced = () => createWorld({ seed: 1, config: QUIET });
  const age = (snake: Snake, lifeTick = 100) => {
    snake.lifeTick = lifeTick;
    return snake;
  };
  const run = (world: World, ticks: number) => {
    const deaths = [];
    for (let t = 0; t < ticks; t++) deaths.push(...step(world, {}).deaths);
    return deaths;
  };

  it("a newborn's body isn't solid: a head passes through it", () => {
    const world = graced();
    place(world, { id: "new", x: 0, y: 0, angle: 0, mass: 200 });
    age(place(world, { id: "old", x: -10, y: -2.5, angle: Math.PI / 2 }));
    expect(run(world, 6)).toEqual([]);
    // It went through the body to the other side.
    expect(world.snakes.find((s) => s.id === "old")?.head.y).toBeGreaterThan(5);
  });

  it("a newborn's head passes through bodies", () => {
    const world = graced();
    age(place(world, { id: "old", x: 0, y: 0, angle: 0, mass: 200 }));
    place(world, { id: "new", x: -10, y: -2.5, angle: Math.PI / 2 });
    expect(run(world, 6)).toEqual([]);
  });

  it("heads meeting a newborn pass through each other, whatever the masses", () => {
    for (const [mNew, mOld] of [
      [20, 50],
      [50, 20],
      [30, 30],
    ] as const) {
      const world = graced();
      place(world, { id: "new", x: -3, y: 0, angle: 0, mass: mNew });
      age(place(world, { id: "old", x: 3, y: 0, angle: Math.PI, mass: mOld }));
      expect(run(world, 4)).toEqual([]);
    }
  });

  it("the wall still kills a newborn", () => {
    const world = graced();
    const h = world.config.arenaHalfSize;
    place(world, { id: "new", x: h - 1, y: 0, angle: 0, mass: 40 });
    step(world, {});
    expect(world.deaths).toMatchObject([{ id: "new", cause: "wall" }]);
  });

  it("a newborn eats", () => {
    const world = graced();
    const me = place(world, { id: "new", x: 0, y: 0, angle: 0 });
    addFood(world, 3, 0, 5, "ambient");
    step(world, {});
    expect(world.food).toHaveLength(0);
    expect(me.mass).toBeGreaterThan(world.config.startMass + 4);
  });

  it("ends after spawnGraceTicks: the body is solid from then on", () => {
    const world = graced();
    const grace = world.config.spawnGraceTicks;
    // As in "collision: head into another body", which kills on the second step; that step is
    // the newborn's first one out of grace.
    const b = age(place(world, { id: "b", x: 0, y: 0, angle: 0, mass: 200 }), grace - 1);
    age(place(world, { id: "a", x: -10, y: -2.5, angle: Math.PI / 2 }));
    step(world, {});
    expect(world.deaths).toEqual([]);
    step(world, {});
    expect(world.deaths).toMatchObject([{ id: "a", cause: "collision", killerId: "b" }]);
    expect(b.kills).toBe(1);
  });

  it("is off in worlds saved before it (no spawnGraceTicks)", () => {
    const world = graced();
    const config: Partial<EngineConfig> = world.config;
    delete config.spawnGraceTicks;
    place(world, { id: "b", x: 0, y: 0, angle: 0, mass: 200 });
    place(world, { id: "a", x: -10, y: -2.5, angle: Math.PI / 2 });
    expect(run(world, 2)).toMatchObject([{ id: "a", cause: "collision", killerId: "b" }]);
  });
});

describe("Grid", () => {
  it("finds every point in a queried range", () => {
    const rng = createRng(3);
    const n = 500;
    const xs = Array.from({ length: n }, () => rng.range(-60, 60));
    const ys = Array.from({ length: n }, () => rng.range(-60, 60));
    const grid = new Grid(50, 7);
    grid.build(n, xs, ys);
    for (let q = 0; q < 50; q++) {
      const cx = rng.range(-55, 55);
      const cy = rng.range(-55, 55);
      const found = new Set<number>();
      for (let row = grid.col(cy - 5); row <= grid.col(cy + 5); row++) {
        for (let col = grid.col(cx - 5); col <= grid.col(cx + 5); col++) {
          for (let i = grid.first(row * grid.cols + col); i >= 0; i = grid.next[i] as number) {
            found.add(i);
          }
        }
      }
      for (let i = 0; i < n; i++) {
        if (Math.abs((xs[i] as number) - cx) <= 5 && Math.abs((ys[i] as number) - cy) <= 5) {
          expect(found.has(i)).toBe(true);
        }
      }
    }
  });
});
