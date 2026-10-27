import { describe, expect, it } from "vitest";
import {
  FrameBuffer,
  interpolateSnake,
  lerpAngle,
  pointFromEnd,
  resamplePolyline,
} from "./interpolate.ts";
import type { RenderFrame, RenderSnake } from "./types.ts";

const frame = (tick: number): RenderFrame => ({ tick, arenaRadius: 10, snakes: [], food: [] });
const snake = (segments: [number, number][], angle = 0): RenderSnake => ({
  id: "s",
  segments: segments.map(([x, y]) => ({ x, y })),
  angle,
  length: segments.length,
  radius: 1,
});
const blank = () => ({
  points: [] as number[],
  pathLength: 0,
  bodyLength: 0,
  blended: false,
  angle: 0,
  radius: 0,
  length: 0,
});

describe("lerpAngle", () => {
  it("takes the short way across ±π", () => {
    expect(lerpAngle(Math.PI - 0.1, -Math.PI + 0.1, 0.5)).toBeCloseTo(Math.PI);
  });
});

describe("resamplePolyline", () => {
  it("emits points at a fixed spacing along the path", () => {
    const out: number[] = [];
    const n = resamplePolyline([0, 0, 1, 0, 1, 2], 0.5, out);
    expect(n).toBe(7); // path length 3 → distances 0, 0.5, ..., 3
    expect(out.slice(4, 6)).toEqual([1, 0]);
    expect(out.slice(-2)).toEqual([1, 2]);
  });

  it("ends exactly at the given length, leaving out a point right before the end", () => {
    const out: number[] = [];
    expect(resamplePolyline([0, 0, 10, 0], 1, out, 4.6)).toBe(6); // 0, 1, 2, 3, 4, 4.6
    expect(out.slice(-4)).toEqual([4, 0, 4.6, 0]);
    expect(resamplePolyline([0, 0, 10, 0], 1, out, 4.1)).toBe(5); // 0, 1, 2, 3, 4.1: 4 is too close
    expect(out.slice(-4)).toEqual([3, 0, 4.1, 0]);
  });

  it("returns the single point of a degenerate path", () => {
    const out: number[] = [];
    expect(resamplePolyline([3, 4], 1, out)).toBe(1);
    expect(out).toEqual([3, 4]);
  });
});

describe("pointFromEnd", () => {
  it("walks the polyline back from its end and clamps to its start", () => {
    const p = { x: 0, y: 0 };
    pointFromEnd([0, 0, 1, 0, 1, 2], 1, p);
    expect(p).toEqual({ x: 1, y: 1 });
    pointFromEnd([0, 0, 1, 0, 1, 2], 9, p);
    expect(p).toEqual({ x: 0, y: 0 });
  });
});

describe("interpolateSnake", () => {
  it("slides the head between ticks and the body along the previous path", () => {
    const out = interpolateSnake(
      snake(
        [
          [0, 0],
          [-1, 0],
        ],
        0,
      ),
      snake(
        [
          [1, 0],
          [0, 0],
        ],
        1,
      ),
      0.5,
      blank(),
    );
    expect(out.points).toEqual([0.5, 0, 0, 0, -1, 0]);
    expect(out.bodyLength).toBe(1);
    expect(out.angle).toBeCloseTo(0.5);
  });

  it("extends a grown snake past the previous tail along the next path", () => {
    const out = interpolateSnake(
      snake([
        [0, 0],
        [-1, 0],
      ]),
      snake([
        [1, 0],
        [0, 0],
        [-1, 0],
        [-2, 0],
      ]),
      0.5,
      blank(),
    );
    expect(out.points).toEqual([0.5, 0, 0, 0, -1, 0, -2, 0]);
    expect(out.bodyLength).toBe(2);
  });

  it("keeps a long coiled snake's tail moving steadily between ticks", () => {
    // Laid out like the engine does: segments `size` apart along the head's path, here a
    // tight circle (radius 6, the engine's sharpest turn at normal speed), the body coiled ~7×.
    const turnRadius = 6;
    const speed = 1.5;
    const size = 2;
    const coiled = (tick: number): RenderSnake => {
      const segments = [];
      for (let k = 0; k < 133; k++) {
        const a = (tick * speed - k * size) / turnRadius;
        segments.push({ x: turnRadius * Math.cos(a), y: turnRadius * Math.sin(a) });
      }
      return { id: "s", segments, angle: 0, length: segments.length, radius: size / 2 };
    };
    const state = blank();
    const drawn: number[] = [];
    const steps: number[] = []; // how far the drawn tail moves from one frame to the next
    let tail: { x: number; y: number } | undefined;
    const frames = 6; // per tick, ~60 fps at 10 ticks/s
    for (let t = 0; t < 20; t++) {
      for (let f = 0; f < frames; f++) {
        interpolateSnake(coiled(t), coiled(t + 1), f / frames, state);
        const n = resamplePolyline(state.points, state.radius * 1.4, drawn, state.bodyLength);
        const next = { x: drawn[2 * n - 2] as number, y: drawn[2 * n - 1] as number };
        if (tail) steps.push(Math.hypot(next.x - tail.x, next.y - tail.y));
        tail = next;
      }
    }
    // Point-by-point blending made these range from ~0 to ~2× the mean every tick.
    const expected = speed / frames;
    for (const d of steps) expect(Math.abs(d - expected)).toBeLessThan(expected * 0.05);
  });

  it("does not interpolate across a respawn", () => {
    const out = interpolateSnake(snake([[0, 0]]), snake([[100, 0]]), 0.5, blank());
    expect(out.points).toEqual([100, 0]);
  });
});

describe("FrameBuffer", () => {
  it("plays back one tick behind the newest frame", () => {
    const buffer = new FrameBuffer(10, 1);
    for (let t = 0; t <= 10; t++) buffer.push(frame(t));
    // Far behind: snaps to latest - delay instead of fast-forwarding.
    const s = buffer.advance(0);
    expect(s?.prev.tick).toBe(9);
    expect(s?.next.tick).toBe(10);
    expect(s?.alpha).toBe(0);
    const half = buffer.advance(0.05);
    expect(half?.alpha).toBeCloseTo(0.5, 1);
  });

  it("never runs past the newest frame", () => {
    const buffer = new FrameBuffer(10, 1);
    buffer.push(frame(0));
    buffer.push(frame(1));
    for (let i = 0; i < 100; i++) buffer.advance(0.1);
    const s = buffer.advance(0.1);
    expect(s?.prev.tick).toBe(1);
    expect(s?.alpha).toBe(0);
  });

  it("starts over when ticks go backwards", () => {
    const buffer = new FrameBuffer();
    buffer.push(frame(50));
    buffer.push(frame(3));
    expect(buffer.advance(0)?.prev.tick).toBe(3);
  });
});
