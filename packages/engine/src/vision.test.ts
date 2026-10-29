import type { BotState } from "@zerosnake/sdk";
import { describe, expect, it } from "vitest";
import { addFood } from "./food.ts";
import { step } from "./step.ts";
import { fingerprint } from "./testing/fingerprint.ts";
import { actionsFor, type Policy, wander } from "./testing/policies.ts";
import { place, QUIET } from "./testing/setup.ts";
import type { Snake, World } from "./types.ts";
import { buildBotInfo, buildBotState } from "./vision.ts";
import { createWorld, spawnSnake } from "./world.ts";

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);

/** Every point and pellet in `state` is within vision of `me`, and nothing visible is missing. */
function checkVision(world: World, me: Snake, state: BotState): void {
  const r = world.config.visionRadius;
  for (const f of state.food) expect(dist(f, me.head)).toBeLessThanOrEqual(r);
  for (const view of state.snakes) {
    expect(view.id).not.toBe(me.id);
    expect(view.segments.length).toBeGreaterThan(0);
    for (const p of view.segments) expect(dist(p, me.head)).toBeLessThanOrEqual(r);
    if (view.head) expect(dist(view.head, me.head)).toBeLessThanOrEqual(r);
  }
  const visibleFood = world.food.filter((f) => dist(f, me.head) <= r);
  expect(state.food.length).toBe(Math.min(visibleFood.length, world.config.visionMaxFood));
  const visibleSnakes = world.snakes.filter(
    (s) => s !== me && s.segments.some((p) => dist(p, me.head) <= r),
  );
  expect(state.snakes.length).toBe(Math.min(visibleSnakes.length, world.config.visionMaxSnakes));
  for (const view of state.snakes) {
    const s = world.snakes.find((o) => o.id === view.id) as Snake;
    expect(view.head === null).toBe(dist(s.head, me.head) > r);
  }
}

describe("buildBotState", () => {
  it("describes the bot's own snake", () => {
    const world = createWorld({ seed: 1, config: QUIET });
    const me = place(world, { id: "me", x: 30, y: 40, angle: Math.PI / 2, mass: 50 });
    step(world, { me: { turn: 0, boost: true } });
    const state = buildBotState(world, "me");
    expect(state.tick).toBe(1);
    expect(state.lifeTick).toBe(1);
    expect(state.self).toEqual({
      id: "me",
      head: me.head,
      angle: me.angle,
      length: me.mass,
      speed: world.config.speed * world.config.boostMultiplier,
      radius: me.size / 2,
      turnRate: world.config.turnRate,
      boosting: true,
      spawnGrace: world.config.spawnGraceTicks - 1,
      segments: me.segments,
    });
    // y is up: heading π/2 moved the head towards +y.
    expect(state.self.head.y).toBeGreaterThan(40);
    const { x, y } = me.head;
    expect(state.wallDistance).toBeCloseTo(89 - Math.max(Math.abs(x), Math.abs(y)), 12);
    expect(buildBotState(world, me)).toEqual(state);
  });

  it("starts lifeTick at 0 for a fresh life", () => {
    const world = createWorld({ seed: 2 });
    for (let t = 0; t < 5; t++) step(world);
    const s = spawnSnake(world, { id: "a", author: "alice" });
    const state = buildBotState(world, s);
    expect(state.tick).toBe(5);
    expect(state.lifeTick).toBe(0);
  });

  it("throws for a snake that is not alive", () => {
    const world = createWorld({ seed: 1 });
    expect(() => buildBotState(world, "ghost")).toThrow(/not alive/);
  });

  it("shows only the visible part of another snake, and its head only when visible", () => {
    const world = createWorld({ seed: 1, config: QUIET });
    const r = world.config.visionRadius;
    place(world, { id: "me", x: 0, y: 0, angle: 0 });
    // Heading +x, body along y = 30 to its left, head beyond vision.
    const other = place(world, { id: "o", x: r + 10, y: 30, angle: 0, mass: 2000 });
    const state = buildBotState(world, "me");
    expect(state.snakes).toHaveLength(1);
    const view = state.snakes[0];
    expect(view?.head).toBeNull();
    expect(view?.angle).toBeNull();
    expect(view?.length).toBe(other.mass);
    expect(view?.author).toBe("o");
    const inside = other.segments.filter((p) => dist(p, { x: 0, y: 0 }) <= r);
    expect(inside.length).toBeGreaterThan(0);
    expect(inside.length).toBeLessThan(other.segments.length);
    expect(view?.segments).toEqual(inside);

    // Move the head into vision.
    const near = place(world, { id: "n", x: 0, y: r / 2, angle: 1 });
    const state2 = buildBotState(world, "me");
    const nearView = state2.snakes.find((s) => s.id === "n");
    expect(nearView?.head).toEqual(near.head);
    expect(nearView?.angle).toBe(1);
    // Nearest first.
    expect(state2.snakes.map((s) => s.id)).toEqual(["n", "o"]);
  });

  it("includes food at exactly the vision radius and nothing beyond it", () => {
    const world = createWorld({ seed: 1, config: QUIET });
    const r = world.config.visionRadius;
    place(world, { id: "me", x: 0, y: 0, angle: 0 });
    addFood(world, r, 0, 1, "ambient");
    addFood(world, 0, -r * (1 + 1e-12), 2, "ambient");
    addFood(world, -3, 4, 3, "remains");
    const state = buildBotState(world, "me");
    expect(state.food).toEqual([
      { x: -3, y: 4, value: 3 },
      { x: r, y: 0, value: 1 },
    ]);
  });

  it("never leaks anything outside the vision radius over a long crowded run", () => {
    const world = createWorld({ seed: 11 });
    const policies: Record<string, Policy> = {};
    let lives = 0;
    const fill = () => {
      while (world.snakes.length < 25) {
        const id = `s${lives++}`;
        policies[id] = wander(lives);
        spawnSnake(world, { id, author: `a${lives % 5}` });
      }
    };
    fill();
    let checked = 0;
    for (let t = 0; t < 400; t++) {
      step(world, actionsFor(world, policies));
      fill();
      if (t % 20 !== 0) continue;
      for (const me of world.snakes) {
        checkVision(world, me, buildBotState(world, me));
        checked++;
      }
    }
    expect(checked).toBe(500);
  });

  it("shares no objects with the world", () => {
    const world = createWorld({ seed: 3 });
    const a = place(world, { id: "a", x: 0, y: 0, angle: 0, mass: 100 });
    place(world, { id: "b", x: 5, y: 5, angle: 0, mass: 100 });
    const before = fingerprint(world);
    const state = buildBotState(world, a);
    state.self.head.x = 99;
    for (const p of state.self.segments) p.y = 99;
    for (const s of state.snakes) {
      if (s.head) s.head.x = 99;
      for (const p of s.segments) p.x = 99;
    }
    for (const f of state.food) f.x = 99;
    expect(fingerprint(world)).toBe(before);
  });
});

describe("state size", () => {
  /** `count` long snakes packed around the origin, heads pointing inwards. */
  function crowd(count: number, config = {}): World {
    const world = createWorld({ seed: 5, config: { ...QUIET, ...config } });
    place(world, { id: "me", x: 0, y: 0, angle: 0, mass: 8000 });
    for (let i = 0; i < count; i++) {
      const a = (2 * Math.PI * i) / count;
      const d = 3 + (i % 10) * 3;
      place(world, {
        id: `o${i}`,
        x: d * Math.cos(a),
        y: d * Math.sin(a),
        angle: a + Math.PI,
        mass: 3000,
      });
    }
    for (let i = 0; i < 2000; i++) {
      const a = i * 2.399963;
      const d = Math.sqrt(i / 2000) * 60;
      addFood(world, d * Math.cos(a), d * Math.sin(a), 1, "ambient");
    }
    return world;
  }

  it("stays within the caps however crowded it gets", () => {
    const world = crowd(120);
    const c = world.config;
    const state = buildBotState(world, "me");
    expect(state.snakes).toHaveLength(c.visionMaxSnakes);
    const points = state.snakes.reduce((n, s) => n + s.segments.length, 0);
    expect(points).toBeLessThanOrEqual(c.visionMaxSegments);
    expect(points).toBeGreaterThan(c.visionMaxSegments * 0.9);
    expect(state.food).toHaveLength(c.visionMaxFood);
    expect(state.self.segments.length).toBeLessThanOrEqual(c.visionMaxSelfSegments);
    // About 50 bytes of JSON per point or pellet: ~30 KB at worst with the default caps.
    expect(JSON.stringify(state).length).toBeLessThan(32_000);
    checkVision(world, world.snakes[0] as Snake, state);
  });

  it("spends the point budget nearest first, keeping each snake's nearest point", () => {
    const world = crowd(10, { visionMaxSegments: 40, visionMaxSelfSegments: 7 });
    const me = world.snakes[0] as Snake;
    const r = world.config.visionRadius;
    const state = buildBotState(world, me);
    const points = state.snakes.reduce((n, s) => n + s.segments.length, 0);
    expect(points).toBe(40);

    // Every visible point of the shown snakes, flagged shown or not.
    const all: { d: number; shown: boolean; forced: boolean }[] = [];
    for (const view of state.snakes) {
      const s = world.snakes.find((o) => o.id === view.id) as Snake;
      const visible = s.segments.filter((p) => dist(p, me.head) <= r);
      const nearest = Math.min(...visible.map((p) => dist(p, me.head)));
      expect(Math.min(...view.segments.map((p) => dist(p, me.head)))).toBe(nearest);
      const shown = new Set(view.segments.map((p) => `${p.x},${p.y}`));
      for (const p of visible) {
        const d = dist(p, me.head);
        all.push({ d, shown: shown.has(`${p.x},${p.y}`), forced: d === nearest });
      }
      // Head to tail order is kept.
      const order = view.segments.map((p) =>
        s.segments.findIndex((q) => q.x === p.x && q.y === p.y),
      );
      expect(order).toEqual([...order].sort((a, b) => a - b));
    }
    // Nothing hidden is nearer than a shown point that was not forced in as a snake's nearest.
    const cut = Math.max(...all.filter((p) => p.shown && !p.forced).map((p) => p.d));
    for (const p of all) if (p.d < cut) expect(p.shown).toBe(true);

    expect(state.self.segments).toHaveLength(7);
    expect(state.self.segments[0]).toEqual(me.head);
    expect(state.self.segments[6]).toEqual(me.segments[me.segments.length - 1]);
  });

  it("shows a body crossing close ahead without gaps, even in a crowd", () => {
    const world = crowd(30);
    const me = world.snakes[0] as Snake;
    // A long body running across the bot's path 4 units ahead.
    const wall = place(world, { id: "wall", x: 4, y: 30, angle: Math.PI / 2, mass: 3000 });
    const state = buildBotState(world, me);
    expect(state.snakes.reduce((n, s) => n + s.segments.length, 0)).toBe(
      world.config.visionMaxSegments,
    );
    const view = state.snakes.find((s) => s.id === "wall");
    if (!view) throw new Error("wall not in view");
    const near = (p: { x: number; y: number }) => dist(p, me.head) <= 15;
    const truth = wall.segments.filter(near);
    expect(view.segments.filter(near)).toEqual(truth);
    // So within that distance no gap is wider than the body (2 × radius).
    for (let k = 1; k < truth.length; k++) {
      expect(dist(truth[k - 1] as Snake["head"], truth[k] as Snake["head"])).toBeLessThanOrEqual(
        2 * view.radius + 1e-9,
      );
    }
    expect(Math.min(...view.segments.map((p) => dist(p, me.head)))).toBeCloseTo(4, 0);
  });

  it("gives every visible snake at least one point when the budget is tiny", () => {
    const world = crowd(20, { visionMaxSegments: 5, visionMaxSnakes: 50 });
    const state = buildBotState(world, "me");
    expect(state.snakes).toHaveLength(5);
    for (const s of state.snakes) expect(s.segments).toHaveLength(1);
  });
});

describe("buildBotInfo", () => {
  it("reports the world's fixed facts and the sandbox limits", () => {
    const world = createWorld({ seed: 4 });
    const s = spawnSnake(world, { id: "a", author: "alice" });
    expect(buildBotInfo(world, s, { opBudget: 1000, logLimitBytes: 512 })).toEqual({
      snakeId: "a",
      worldHalfSize: world.config.arenaHalfSize,
      visionRadius: world.config.visionRadius,
      tickRate: 10,
      maxLifeTicks: world.config.lifeCap,
      opBudget: 1000,
      logLimitBytes: 512,
      seed: s.seed,
    });
  });
});
