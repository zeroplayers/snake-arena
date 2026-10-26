import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createRatingConfig } from "./config.ts";
import { addLife, EMPTY_RATING_STATE, rate } from "./rating.ts";
import { decodeScores, encodeScores, fromRatingsRow, toRatingsRow } from "./storage.ts";

describe("ratings row", () => {
  it("round-trips the state exactly", () => {
    const config = createRatingConfig({ window: 16 });
    fc.assert(
      fc.property(
        fc.array(
          fc.double({ noNaN: true, noDefaultInfinity: true }).map((x) => x || 0),
          { minLength: 1, maxLength: 40 },
        ),
        (xs) => {
          const state = xs.reduce((s, x) => addLife(s, x, config), EMPTY_RATING_STATE);
          const row = toRatingsRow(state, config);
          const back = fromRatingsRow(JSON.parse(JSON.stringify(row)), config);
          expect(back).toEqual(state);
          expect(rate(back, config)).toEqual(rate(state, config));
        },
      ),
    );
  });

  it("writes the leaderboard columns", () => {
    const state = [10, 20, 30].reduce((s, x) => addLife(s, x), EMPTY_RATING_STATE);
    const row = toRatingsRow(state);
    expect(row).toMatchObject({ mean: 20, nLives: 3, recentScores: "[10,20,30]" });
    expect(row.ci).toBeCloseTo(1.96 * (10 / Math.sqrt(3)), 12);
  });

  it("stores a missing interval as null", () => {
    expect(toRatingsRow(addLife(EMPTY_RATING_STATE, 5)).ci).toBeNull();
  });

  it("has nothing to write before the first life", () => {
    expect(() => toRatingsRow(EMPTY_RATING_STATE)).toThrow(RangeError);
  });

  it("rejects malformed stored scores", () => {
    for (const bad of ["{}", '[1,"2"]', "[null]", "1"]) {
      expect(() => decodeScores(bad)).toThrow(TypeError);
    }
    expect(() => decodeScores("[1,")).toThrow(SyntaxError);
    expect(decodeScores(encodeScores([0.1, -2, 1e300]))).toEqual([0.1, -2, 1e300]);
  });
});
