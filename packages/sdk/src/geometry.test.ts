import { describe, expect, it } from "vitest";
import {
  angleDiff,
  angleTo,
  clamp,
  distance,
  distanceSq,
  distanceToWall,
  nearest,
  nearestDanger,
  nearestFood,
  normalizeAngle,
  project,
  steerAway,
  steerToward,
  TAU,
  turnToward,
} from "./geometry.ts";
import type { SelfState, SnakeView } from "./types.ts";

const PI = Math.PI;

function self(overrides: Partial<SelfState> = {}): SelfState {
  return {
    id: "me",
    head: { x: 0, y: 0 },
    angle: 0,
    length: 10,
    speed: 1,
    radius: 1,
    turnRate: 0.1,
    boosting: false,
    segments: [{ x: 0, y: 0 }],
    ...overrides,
  };
}

function snake(segments: { x: number; y: number }[], radius = 1): SnakeView {
  return {
    id: "s",
    author: "a",
    length: 10,
    radius,
    head: segments[0] ?? null,
    angle: 0,
    boosting: false,
    segments,
  };
}

describe("clamp", () => {
  it("clamps and maps NaN to min", () => {
    expect(clamp(5, -1, 1)).toBe(1);
    expect(clamp(-5, -1, 1)).toBe(-1);
    expect(clamp(0.3, -1, 1)).toBe(0.3);
    expect(clamp(Number.NaN, -1, 1)).toBe(-1);
  });
});

describe("distance", () => {
  it("is euclidean", () => {
    expect(distance({ x: 1, y: 2 }, { x: 4, y: 6 })).toBe(5);
    expect(distanceSq({ x: 1, y: 2 }, { x: 4, y: 6 })).toBe(25);
  });
});

describe("normalizeAngle", () => {
  it("maps into (-π, π]", () => {
    expect(normalizeAngle(0)).toBe(0);
    expect(normalizeAngle(PI)).toBe(PI);
    expect(normalizeAngle(-PI)).toBe(PI);
    expect(normalizeAngle((3 * PI) / 2)).toBeCloseTo(-PI / 2);
    expect(normalizeAngle(-(3 * PI) / 2)).toBeCloseTo(PI / 2);
    expect(normalizeAngle(5 * TAU + 0.25)).toBeCloseTo(0.25);
    expect(normalizeAngle(-5 * TAU - 0.25)).toBeCloseTo(-0.25);
  });

  it("stays in range for many inputs", () => {
    for (let a = -20; a <= 20; a += 0.037) {
      const n = normalizeAngle(a);
      expect(n).toBeGreaterThan(-PI);
      expect(n).toBeLessThanOrEqual(PI);
      expect(Math.cos(n)).toBeCloseTo(Math.cos(a));
      expect(Math.sin(n)).toBeCloseTo(Math.sin(a));
    }
  });
});

describe("angleTo", () => {
  it("follows the y-up, counter-clockwise convention", () => {
    const o = { x: 0, y: 0 };
    expect(angleTo(o, { x: 1, y: 0 })).toBe(0); // east
    expect(angleTo(o, { x: 0, y: 1 })).toBeCloseTo(PI / 2); // north (up)
    expect(angleTo(o, { x: 0, y: -1 })).toBeCloseTo(-PI / 2); // south (down)
    expect(angleTo(o, { x: -1, y: 0 })).toBe(PI); // west
    expect(angleTo(o, { x: -1, y: -0 })).toBe(PI); // -0 does not yield -π
    expect(angleTo(o, o)).toBe(0);
  });
});

describe("angleDiff", () => {
  it("takes the short way round across ±π", () => {
    expect(angleDiff(PI - 0.1, -PI + 0.1)).toBeCloseTo(0.2);
    expect(angleDiff(-PI + 0.1, PI - 0.1)).toBeCloseTo(-0.2);
  });

  it("is positive for a left (counter-clockwise) target", () => {
    // Facing east, a target to the north (y up) is on the left.
    expect(angleDiff(0, PI / 2)).toBeCloseTo(PI / 2);
    expect(angleDiff(0, -PI / 2)).toBeCloseTo(-PI / 2);
  });
});

describe("turnToward", () => {
  it("is negative (left) for a counter-clockwise target, positive (right) for clockwise", () => {
    expect(turnToward(self({ angle: 0 }), PI / 2)).toBe(-1);
    expect(turnToward(self({ angle: 0 }), -PI / 2)).toBe(1);
  });

  it("returns a proportional turn when within one tick", () => {
    expect(turnToward(self({ angle: 0, turnRate: 0.1 }), 0.05)).toBeCloseTo(-0.5);
    expect(turnToward(self({ angle: 0, turnRate: 0.1 }), -0.05)).toBeCloseTo(0.5);
    expect(turnToward(self({ angle: 0, turnRate: 0.1 }), 0)).toBe(0);
  });

  it("clamps to [-1, 1]", () => {
    expect(turnToward(self({ angle: 0 }), 2)).toBe(-1);
    expect(turnToward(self({ angle: 0 }), -2)).toBe(1);
  });

  it("wraps across ±π", () => {
    // From just below π to just above -π is a small counter-clockwise (left) step.
    expect(turnToward(self({ angle: PI - 0.05, turnRate: 0.1 }), -PI + 0.05)).toBeCloseTo(-1);
  });

  it("handles a zero turn rate", () => {
    expect(turnToward(self({ turnRate: 0 }), 1)).toBe(-1);
    expect(turnToward(self({ turnRate: 0 }), 0)).toBe(0);
  });

  it("converges when applied the way the engine does (angle -= turn * turnRate)", () => {
    for (const [start, target] of [
      [2.5, -1],
      [-2.5, 1],
      [3, -3],
    ] as const) {
      let s = self({ angle: start, turnRate: 0.2 });
      for (let i = 0; i < 40; i++) {
        s = { ...s, angle: normalizeAngle(s.angle - turnToward(s, target) * s.turnRate) };
      }
      expect(s.angle).toBeCloseTo(target);
    }
  });
});

describe("steerToward / steerAway", () => {
  it("gives a negative turn toward a point on the left", () => {
    const me = self({ head: { x: 0, y: 0 }, angle: 0 });
    // Heading east, y up: (1, 10) is up-left of us, (1, -10) is down-right.
    expect(steerToward(me, { x: 1, y: 10 })).toBe(-1);
    expect(steerToward(me, { x: 1, y: -10 })).toBe(1);
    expect(steerToward(me, { x: 10, y: 0 })).toBe(0);
  });

  it("turns away from a point", () => {
    const me = self({ head: { x: 0, y: 0 }, angle: PI / 2 });
    // Heading north, threat to the south-east: flee north-west, i.e. turn left.
    expect(steerAway(me, { x: 1, y: -1 })).toBe(-1);
    expect(steerAway(me, { x: 0, y: -5 })).toBe(0);
  });
});

describe("project", () => {
  it("moves along the heading", () => {
    const p = project({ x: 1, y: 1 }, PI / 2, 3);
    expect(p.x).toBeCloseTo(1);
    expect(p.y).toBeCloseTo(4);
  });
});

describe("distanceToWall", () => {
  it("measures to the circular edge", () => {
    expect(distanceToWall({ x: 0, y: 0 }, 100)).toBe(100);
    expect(distanceToWall({ x: 30, y: 40 }, 100)).toBe(50);
    expect(distanceToWall({ x: 0, y: 110 }, 100)).toBe(-10);
  });
});

describe("nearest / nearestFood", () => {
  it("returns undefined for no items", () => {
    expect(nearest({ x: 0, y: 0 }, [])).toBeUndefined();
    expect(nearestFood({ self: self(), food: [] })).toBeUndefined();
  });

  it("picks the closest item and keeps its type", () => {
    const food = [
      { x: 5, y: 5, value: 1 },
      { x: -1, y: 1, value: 3 },
      { x: 2, y: 0, value: 2 },
    ];
    expect(nearestFood({ self: self(), food })).toBe(food[1]);
    expect(nearestFood({ self: self({ head: { x: 6, y: 6 } }), food })?.value).toBe(1);
  });
});

describe("nearestDanger", () => {
  it("returns undefined with no snakes", () => {
    expect(nearestDanger({ self: self(), snakes: [] })).toBeUndefined();
  });

  it("finds the closest segment and the gap", () => {
    const far = snake([{ x: 20, y: 0 }]);
    const near = snake(
      [
        { x: 10, y: 10 },
        { x: 0, y: 5 },
      ],
      2,
    );
    const d = nearestDanger({ self: self({ radius: 1 }), snakes: [far, near] });
    expect(d?.snake).toBe(near);
    expect(d?.point).toEqual({ x: 0, y: 5 });
    expect(d?.distance).toBe(5);
    expect(d?.gap).toBe(2);
  });
});
