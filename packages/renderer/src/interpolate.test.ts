import { describe, expect, it } from "vitest";
import { FrameBuffer, interpolateSnake, lerpAngle, resamplePolyline } from "./interpolate.ts";
import type { RenderFrame, RenderSnake } from "./types.ts";

const frame = (tick: number): RenderFrame => ({ tick, arenaRadius: 10, snakes: [], food: [] });
const snake = (segments: [number, number][], angle = 0): RenderSnake => ({
  id: "s",
  segments: segments.map(([x, y]) => ({ x, y })),
  angle,
  length: segments.length,
  radius: 1,
});
const blank = () => ({ points: [] as number[], angle: 0, radius: 0, length: 0 });

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

  it("returns the single point of a degenerate path", () => {
    const out: number[] = [];
    expect(resamplePolyline([3, 4], 1, out)).toBe(1);
    expect(out).toEqual([3, 4]);
  });
});

describe("interpolateSnake", () => {
  it("blends points and heading", () => {
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
    expect(out.points).toEqual([0.5, 0, -0.5, 0]);
    expect(out.angle).toBeCloseTo(0.5);
  });

  it("extends a grown snake from the previous tail", () => {
    const out = interpolateSnake(
      snake([[0, 0]]),
      snake([
        [1, 0],
        [0, 0],
      ]),
      0.5,
      blank(),
    );
    expect(out.points).toEqual([0.5, 0, 0, 0]);
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
