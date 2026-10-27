import { describe, expect, it } from "vitest";
import {
  BROADCAST_VERSION,
  BroadcastEncoder,
  BroadcastFormatError,
  BroadcastGapError,
  BroadcastView,
  decodeBroadcast,
  encodeBroadcast,
  type TickDelta,
} from "./broadcast.ts";
import { createRng } from "./rng.ts";
import { step } from "./step.ts";
import { actionsFor, farm, type Policy, wander } from "./testing/policies.ts";
import { place } from "./testing/setup.ts";
import type { Fault, World } from "./types.ts";
import { createWorld, spawnSnake } from "./world.ts";

const options = { stream: 7, room: "room-1", bot: (id: string) => `v-${id}` };

/** A room as the arena runs it: `snakes` bots, the dead replaced, the odd fault. */
function room(seed: number, snakes = 15) {
  const world = createWorld({ seed });
  const policies: Record<string, Policy> = {};
  const faults = createRng(seed + 1);
  let lives = 0;
  const fill = () => {
    while (world.snakes.length < snakes) {
      const id = `s${lives++}`;
      policies[id] = lives % 3 === 0 ? farm : wander(seed * 1000 + lives);
      spawnSnake(world, { id, author: `author${lives % 6}` });
    }
  };
  fill();
  return {
    world,
    /** One room tick: the step, then spawns (the next batch's, as a room does them). */
    tick() {
      const f: Record<string, Fault> = {};
      if (faults.next() < 0.01 && world.snakes.length > 0) {
        const victim = world.snakes[faults.int(world.snakes.length)];
        if (victim) f[victim.id] = "error";
      }
      step(world, actionsFor(world, policies), f);
    },
    fill,
  };
}

/** What a spectator must show equals the world, up to float32 rounding. */
function expectMatches(view: BroadcastView, world: World): void {
  expect(view.tick).toBe(world.tick);
  expect(view.snakes.map((v) => v.life.id)).toEqual(world.snakes.map((s) => s.id));
  view.snakes.forEach((v, i) => {
    const s = world.snakes[i] as World["snakes"][number];
    expect(v.life.author).toBe(s.author);
    expect(v.life.bot).toBe(`v-${s.id}`);
    expect(v.life.bornTick).toBe(s.bornTick);
    expect(v.snake.lifeTick).toBe(s.lifeTick);
    expect(v.snake.boosting).toBe(s.boosting);
    expect(v.snake.kills).toBe(s.kills);
    expect(v.snake.mass).toBeCloseTo(s.mass, 3);
    expect(v.snake.angle).toBeCloseTo(s.angle, 5);
    expect(v.snake.segments.length).toBe(s.segments.length);
    v.snake.segments.forEach((p, k) => {
      const q = s.segments[k] as { x: number; y: number };
      expect(Math.abs(p.x - q.x)).toBeLessThan(1e-3);
      expect(Math.abs(p.y - q.y)).toBeLessThan(1e-3);
    });
  });
  expect([...view.food.keys()].sort((a, b) => a - b)).toEqual(
    world.food.map((f) => f.id).sort((a, b) => a - b),
  );
  for (const f of world.food) {
    const g = view.food.get(f.id);
    expect(g?.kind).toBe(f.kind);
    expect(g?.x).toBeCloseTo(f.x, 4);
  }
}

describe("broadcast", () => {
  it("round-trips a long room through the wire, ten ticks a message", () => {
    const r = room(11);
    const encoder = new BroadcastEncoder(r.world, options);
    const view = new BroadcastView();
    view.apply(decodeBroadcast(encodeBroadcast(encoder.keyframe(r.world))));
    expectMatches(view, r.world);

    let deaths = 0;
    let spawns = 0;
    let biggest = 0;
    for (let batch = 0; batch < 150; batch++) {
      r.fill();
      const ticks: TickDelta[] = [];
      for (let k = 0; k < 10; k++) {
        r.tick();
        ticks.push(encoder.step(r.world));
        deaths += r.world.deaths.length;
      }
      spawns += ticks.reduce((n, t) => n + t.snakes.filter((s) => s.trail).length, 0);
      const bytes = encodeBroadcast({ kind: "ticks", stream: encoder.stream, ticks });
      biggest = Math.max(biggest, bytes.length);
      const decoded = decodeBroadcast(bytes);
      expect(decoded).toEqual({ kind: "ticks", stream: 7, ticks: expect.any(Array) });
      view.apply(decoded);
      expectMatches(view, r.world);
    }
    expect(deaths).toBeGreaterThan(10);
    expect(spawns).toBeGreaterThan(10);
    // Ten ticks of 15 snakes: a few KB, not the bodies.
    expect(biggest).toBeLessThan(16_000);
  }, 30_000);

  it("reports deaths with their killer and lets a late spectator start from a keyframe", () => {
    const world = createWorld({ seed: 1, config: { foodBase: 0, foodPerSnake: 0 } });
    // b runs head-first into a's body (as in collision.test.ts).
    place(world, { id: "a", x: 0, y: 0, angle: 0, mass: 200 });
    place(world, { id: "b", x: -10, y: -2.5, angle: Math.PI / 2 });
    const encoder = new BroadcastEncoder(world, options);
    const view = new BroadcastView();
    view.apply(decodeBroadcast(encodeBroadcast(encoder.keyframe(world))));
    let died: TickDelta | undefined;
    for (let t = 0; t < 20 && !died; t++) {
      step(world, {});
      const delta = encoder.step(world);
      view.apply(decodeBroadcast(encodeBroadcast({ kind: "ticks", stream: 7, ticks: [delta] })));
      if (delta.deaths.length > 0) died = delta;
    }
    expect(died?.deaths).toEqual([
      expect.objectContaining({ slot: 1, cause: "collision", killerSlot: 0 }),
    ]);
    expect(view.deaths.map((d) => [d.life.id, d.cause])).toEqual([["b", "collision"]]);
    expect(view.snakes.map((v) => v.life.id)).toEqual(["a"]);

    const late = new BroadcastView();
    late.apply(decodeBroadcast(encodeBroadcast(encoder.keyframe(world))));
    expectMatches(late, world);
    step(world, {});
    const next = encodeBroadcast({ kind: "ticks", stream: 7, ticks: [encoder.step(world)] });
    late.apply(decodeBroadcast(next));
    view.apply(decodeBroadcast(next));
    expectMatches(late, world);
    expectMatches(view, world);
  });

  it("refuses deltas that don't follow the view", () => {
    const r = room(2, 5);
    const encoder = new BroadcastEncoder(r.world, options);
    const view = new BroadcastView();
    view.apply(encoder.keyframe(r.world));
    r.tick();
    const first = encoder.step(r.world);
    r.tick();
    const second = encoder.step(r.world);
    expect(() => view.apply({ kind: "ticks", stream: 7, ticks: [second] })).toThrow(
      BroadcastGapError,
    );
    expect(() => view.apply({ kind: "ticks", stream: 8, ticks: [first] })).toThrow(
      BroadcastGapError,
    );
    view.apply({ kind: "ticks", stream: 7, ticks: [first, second] });
    expectMatches(view, r.world);
    // The encoder only goes forward one frame at a time.
    expect(() => encoder.step(r.world)).toThrow();
  });

  it("refuses other versions and malformed bytes", () => {
    const r = room(3, 5);
    const bytes = encodeBroadcast(new BroadcastEncoder(r.world, options).keyframe(r.world));
    expect(bytes[1]).toBe(BROADCAST_VERSION);
    const other = bytes.slice();
    other[1] = BROADCAST_VERSION + 1;
    expect(() => decodeBroadcast(other)).toThrow(/version/);
    expect(() => decodeBroadcast(bytes.subarray(0, bytes.length - 3))).toThrow(
      BroadcastFormatError,
    );
    expect(() => decodeBroadcast(new Uint8Array([0x5a, BROADCAST_VERSION, 9]))).toThrow(
      BroadcastFormatError,
    );
    const rng = createRng(4);
    for (let i = 0; i < 200; i++) {
      const junk = bytes.slice(0, 3 + rng.int(200));
      for (let k = 3; k < junk.length; k++) if (rng.next() < 0.1) junk[k] = rng.int(256);
      try {
        decodeBroadcast(junk);
      } catch (e) {
        expect(e).toBeInstanceOf(BroadcastFormatError);
      }
    }
  });

  it("keeps a keyframe of a full room bounded", () => {
    const world = createWorld({ seed: 5 });
    for (let i = 0; i < 20; i++) {
      place(world, {
        id: `big-${i}-${"x".repeat(300)}`,
        author: i === 0 ? "é".repeat(300) : `a${"🐍".repeat(150)}`,
        x: -80 + 8 * i,
        y: 0,
        angle: Math.PI / 2,
        mass: 5000,
      });
    }
    while (world.food.length < world.config.maxFood) {
      world.food.push({ id: world.nextFoodId++, x: 1, y: 1, value: 1, kind: "remains" });
    }
    const encoder = new BroadcastEncoder(world, options);
    const bytes = encodeBroadcast(encoder.keyframe(world));
    expect(bytes.length).toBeLessThan(400_000);
    const back = decodeBroadcast(bytes);
    if (back.kind !== "keyframe") throw new Error("not a keyframe");
    // Labels are cut to 100 code units, never inside a character.
    expect(back.snakes[0]?.life?.author).toBe("é".repeat(100));
    expect(back.snakes[0]?.life?.id).toHaveLength(100);
    expect(back.snakes[1]?.life?.author).toBe(`a${"🐍".repeat(49)}`);
    expect(back.food).toHaveLength(world.config.maxFood);
  });
});
