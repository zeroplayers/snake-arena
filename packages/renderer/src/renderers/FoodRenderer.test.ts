import { describe, expect, it } from "vitest";
import { foodGlowScale } from "./FoodRenderer.ts";

describe("foodGlowScale", () => {
  it("gives ambient-sized and smaller pellets the full halo", () => {
    expect(foodGlowScale(0.5)).toBe(foodGlowScale(0.25));
  });

  it("grows the halo of bigger pellets only with √size", () => {
    const base = foodGlowScale(0.5);
    const big = foodGlowScale(0.8);
    expect(big).toBeLessThan(base);
    expect((0.8 * big) / (0.5 * base)).toBeCloseTo(Math.sqrt(0.8 / 0.5), 12);
  });
});
