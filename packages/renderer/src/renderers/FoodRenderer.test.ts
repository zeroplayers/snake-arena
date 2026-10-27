import { describe, expect, it } from "vitest";
import { foodGlow } from "./FoodRenderer.ts";

describe("foodGlow", () => {
  it("gives ambient-sized and smaller pellets the full halo", () => {
    expect(foodGlow(0.5)).toEqual(foodGlow(0.25));
    expect(foodGlow(0.5).intensity).toBe(1);
  });

  it("tames the halo of bigger pellets", () => {
    const base = foodGlow(0.5);
    const big = foodGlow(0.8);
    // Relative to the pellet the halo shrinks, and in world units it grows only with √size.
    expect(big.scale).toBeLessThan(base.scale);
    expect((0.8 * big.scale) / (0.5 * base.scale)).toBeCloseTo(Math.sqrt(0.8 / 0.5), 12);
    expect(big.intensity).toBeCloseTo(0.5 / 0.8, 12);
  });
});
