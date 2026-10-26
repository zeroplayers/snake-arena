import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_NORMALIZATION,
  type NormalizationConfig,
  normalizeScore,
  roomStrength,
} from "./normalize.ts";

const on: NormalizationConfig = { enabled: true, reference: 100, alpha: 1, maxFactor: 2 };

describe("normalizeScore", () => {
  it("is off by default", () => {
    expect(DEFAULT_NORMALIZATION.enabled).toBe(false);
    expect(normalizeScore(123, 1e6)).toBe(123);
  });

  it("scales by (strength / reference) ^ alpha", () => {
    expect(normalizeScore(50, 100, on)).toBe(50);
    expect(normalizeScore(50, 150, on)).toBe(75);
    expect(normalizeScore(50, 400, { ...on, alpha: 0.5 })).toBe(100);
  });

  it("clamps the factor to maxFactor either way", () => {
    expect(normalizeScore(50, 1000, on)).toBe(100);
    expect(normalizeScore(50, 1, on)).toBe(25);
  });

  it("leaves a score alone when the strength is meaningless", () => {
    for (const s of [0, -5, Number.NaN]) expect(normalizeScore(50, s, on)).toBe(50);
  });

  it("never lowers a score for a stronger room", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1e6, noNaN: true }),
        fc.double({ min: 1, max: 1e4, noNaN: true }),
        fc.double({ min: 1, max: 1e4, noNaN: true }),
        fc.double({ min: 0, max: 2, noNaN: true }),
        (score, a, b, alpha) => {
          const [weak, strong] = a < b ? [a, b] : [b, a];
          const c = { ...on, alpha };
          expect(normalizeScore(score, strong, c)).toBeGreaterThanOrEqual(
            normalizeScore(score, weak, c) * (1 - 1e-12),
          );
        },
      ),
    );
  });
});

describe("roomStrength", () => {
  it("is the weighted mean of the others' ratings", () => {
    expect(roomStrength([{ rating: 100 }, { rating: 300 }], 0)).toBe(200);
    expect(
      roomStrength(
        [
          { rating: 100, weight: 3 },
          { rating: 300, weight: 1 },
        ],
        0,
      ),
    ).toBe(150);
  });

  it("counts unrated snakes, and an empty room, as `unrated`", () => {
    expect(roomStrength([{ rating: null }, { rating: 300 }], 100)).toBe(200);
    expect(roomStrength([], 100)).toBe(100);
    expect(roomStrength([{ rating: 5, weight: 0 }], 100)).toBe(100);
  });
});
