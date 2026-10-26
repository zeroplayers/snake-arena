import { turnToward } from "@zerosnake/sdk";
import { describe, expect, it } from "vitest";
import {
  arenaRadius,
  castRay,
  collectObstacles,
  createRandom,
  pathClearance,
  reachable,
  steer,
} from "./common.ts";
import { line, self, snake, state } from "./testing.ts";

describe("arenaRadius", () => {
  it("is recovered from the head and wallDistance", () => {
    expect(arenaRadius(state({ self: self({ head: { x: 30, y: 40 } }) }))).toBeCloseTo(100);
  });
});

describe("castRay", () => {
  const dot = [{ x: 10, y: 0, r: 1 }];

  it("stops at the first circle on the road", () => {
    expect(castRay({ x: 0, y: 0 }, 0, dot, 100, 50)).toBeCloseTo(9);
  });

  it("ignores circles beside or behind the road", () => {
    expect(castRay({ x: 0, y: 0 }, Math.PI / 2, dot, 100, 50)).toBe(50);
    expect(castRay({ x: 0, y: 0 }, Math.PI, dot, 100, 50)).toBe(50);
  });

  it("stops at the wall", () => {
    expect(castRay({ x: 90, y: 0 }, 0, [], 100, 50)).toBeCloseTo(10);
    expect(castRay({ x: 90, y: 0 }, Math.PI, [], 100, 50)).toBe(50);
    expect(castRay({ x: 101, y: 0 }, Math.PI, [], 100, 50)).toBe(0);
  });
});

describe("pathClearance", () => {
  const me = self(); // turn radius 1.5 / 0.25 = 6

  it("follows the turning circle before going straight", () => {
    // A left U-turn ends 12 above the start heading west; a dot there blocks it, not the
    // straight road.
    const dot = [{ x: 0, y: 12, r: 1 }];
    expect(pathClearance(me, 0, dot, 100, 30)).toBe(30);
    expect(pathClearance(me, Math.PI, dot, 100, 30)).toBeLessThan(6 * Math.PI);
    expect(pathClearance(me, -Math.PI, dot, 100, 30)).toBe(30);
  });

  it("sees the wall on the outside of a turn", () => {
    const nearWall = self({ head: { x: 0, y: 93 } });
    expect(pathClearance(nearWall, Math.PI / 2, [], 99.5, 30)).toBeLessThan(10);
    expect(pathClearance(nearWall, -Math.PI / 2, [], 99.5, 30)).toBe(30);
  });
});

describe("reachable", () => {
  it("rejects points inside the turning circle", () => {
    expect(reachable(self(), { x: 10, y: 0 })).toBe(true);
    expect(reachable(self(), { x: 0, y: 3 })).toBe(false);
    expect(reachable(self(), { x: 0, y: 12 })).toBe(true);
  });
});

describe("collectObstacles", () => {
  it("keeps nearby body points and projects heads forward", () => {
    const other = snake(line({ x: 5, y: 0 }, 0, 3), { angle: Math.PI / 2 });
    const far = snake([{ x: 60, y: 0 }]);
    const obs = collectObstacles(state({ snakes: [other, far] }), {
      range: 20,
      margin: 1,
      headLead: 2,
    });
    expect(obs.map((o) => [o.x, o.y])).toEqual([
      [5, 0],
      [6, 0],
      [7, 0],
      [5, expect.closeTo(1.5)],
      [5, expect.closeTo(3)],
    ]);
    expect(obs[0]?.r).toBe(2); // 0.5 + 0.5 + margin
  });

  it("can leave out harmless heads", () => {
    const other = snake(line({ x: 5, y: 0 }, 0, 3));
    const obs = collectObstacles(state({ snakes: [other] }), {
      range: 20,
      margin: 0,
      headLead: 2,
      harmlessHead: () => true,
    });
    expect(obs.map((o) => o.x)).toEqual([6, 7]);
  });
});

describe("steer", () => {
  const opts = { rays: 16, lookahead: 20, safe: 10, dangerWeight: 10 };

  it("takes the desired heading exactly when it is open", () => {
    const s = steer(state(), [], 0.1, opts);
    expect(s.angle).toBeCloseTo(0.1);
    expect(s.turn).toBeCloseTo(-0.4);
  });

  it("turns the way it planned for a U-turn", () => {
    // Straight back is offset +π, checked as a left U-turn. turnToward() would resolve ±π to
    // a right turn, which here runs into the wall.
    const nearWall = state({ self: self({ head: { x: 0, y: -95 } }) });
    const s = steer(nearWall, [], Math.PI, opts);
    expect(s.clearance).toBe(opts.lookahead);
    expect(s.turn).toBe(-1);
    expect(turnToward(nearWall.self, s.angle)).toBe(1);
  });

  it("avoids a blocked road and reports the clearance ahead", () => {
    const s = steer(state(), [{ x: 5, y: 0, r: 2 }], 0, opts);
    expect(s.ahead).toBeCloseTo(3);
    expect(Math.abs(s.turn)).toBe(1);
    expect(s.clearance).toBeGreaterThanOrEqual(opts.safe);
  });

  it("keeps turning the same way when both ways are as good", () => {
    // A circle dead ahead: left and right cost the same, and the tie goes left.
    const block = [{ x: 5, y: 0, r: 2 }];
    expect(steer(state(), block, 0, opts, 1).turn).toBe(-1);
    const holding = { ...opts, reversalCost: 0.5 };
    expect(steer(state(), block, 0, holding).turn).toBe(-1);
    expect(steer(state(), block, 0, holding, 1).turn).toBe(1);
    expect(steer(state(), block, 0, holding, -1).turn).toBe(-1);
  });
});

describe("createRandom", () => {
  it("is deterministic per seed and stays in [0, 1)", () => {
    const a = createRandom(42);
    const b = createRandom(42);
    const c = createRandom(43);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(xs.slice(0, 5)).toEqual(Array.from({ length: 5 }, () => b()));
    expect(c()).not.toBe(xs[0]);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
  });
});
