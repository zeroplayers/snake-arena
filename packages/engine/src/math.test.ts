import { describe, expect, it } from "vitest";
import { atan2, exitTime, squareNorm, wrapAngle } from "./math.ts";
import { createRng } from "./rng.ts";
import { createWorld, spawnSnake } from "./world.ts";

describe("atan2", () => {
  it("matches Math.atan2 everywhere", () => {
    const rng = createRng(1);
    for (let i = 0; i < 10_000; i++) {
      const x = rng.range(-100, 100);
      const y = rng.range(-100, 100);
      expect(atan2(y, x)).toBeCloseTo(Math.atan2(y, x), 13);
    }
    for (const [y, x] of [
      [0, 1],
      [1, 0],
      [0, -1],
      [-1, 0],
      [1, 1],
      [-1, -1],
      [1e-9, 1e9],
    ]) {
      expect(atan2(y as number, x as number)).toBeCloseTo(Math.atan2(y as number, x as number), 13);
    }
    expect(atan2(0, 0)).toBe(0);
  });
});

describe("exitTime", () => {
  it("is when the point first reaches either pair of edges", () => {
    expect(exitTime(8, 0, 4, 0, 10)).toBe(0.5);
    expect(exitTime(0, -8, 0, -4, 10)).toBe(0.5);
    // Diagonal: x reaches the edge at t = 0.25, y would at 0.5.
    expect(exitTime(9, 8, 4, 4, 10)).toBe(0.25);
    expect(exitTime(0, 0, 1, 1, 10)).toBe(1);
    expect(exitTime(11, 0, 1, 0, 10)).toBe(0);
  });
});

describe("spawning", () => {
  it("places snakes inside the spawn square, facing the centre", () => {
    const world = createWorld({ seed: 5 });
    const c = world.config;
    let corner = false;
    for (let i = 0; i < 200; i++) {
      const s = spawnSnake(world, { id: `s${i}`, author: "a" });
      const { x, y } = s.head;
      expect(squareNorm(x, y)).toBeLessThanOrEqual(c.arenaHalfSize * c.spawnHalfSizeFactor);
      if (Math.hypot(x, y) > c.arenaHalfSize * c.spawnHalfSizeFactor) corner = true;
      expect(Math.abs(wrapAngle(s.angle - Math.atan2(-y, -x)))).toBeLessThan(1e-12);
    }
    // Uniform over the square, so the corners beyond the inscribed circle get some.
    expect(corner).toBe(true);
  });
});
