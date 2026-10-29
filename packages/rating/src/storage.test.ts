import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createRatingConfig } from "./config.ts";
import { DEFAULT_NORMALIZATION } from "./normalize.ts";
import { addLife, EMPTY_RATING_STATE, MAX_LIFE_SCORE, rate } from "./rating.ts";
import { tQuantile } from "./stats.ts";
import {
  decodeWindow,
  encodeWindow,
  fromRatingsRow,
  RAW_SCORING,
  scoringKey,
  toRatingsRow,
} from "./storage.ts";

const anyLife = fc.record({
  score: fc.double({ min: -MAX_LIFE_SCORE, max: MAX_LIFE_SCORE, noNaN: true }).map((x) => x || 0),
  ticks: fc.integer({ min: 1, max: 864_000 }),
});
const minute = (score: number) => ({ score, ticks: 600 });

describe("ratings row", () => {
  it("round-trips the state exactly", () => {
    const config = createRatingConfig({ window: 16 });
    fc.assert(
      fc.property(fc.array(anyLife, { minLength: 1, maxLength: 40 }), (lives) => {
        const state = lives.reduce((s, l) => addLife(s, l, config), EMPTY_RATING_STATE);
        const row = toRatingsRow(state, config);
        const back = fromRatingsRow(JSON.parse(JSON.stringify(row)), config);
        expect(back).toEqual(state);
        expect(back && rate(back, config)).toEqual(rate(state, config));
      }),
    );
  });

  it("writes the leaderboard columns", () => {
    const state = [10, 20, 30].reduce((s, x) => addLife(s, minute(x)), EMPTY_RATING_STATE);
    const row = toRatingsRow(state);
    const ci = tQuantile(1.96, 2) * (10 / Math.sqrt(3));
    expect(row).toMatchObject({ mean: 20, nLives: 3, aliveTicks: 1800 });
    expect(row.ci).toBeCloseTo(ci, 9);
    expect(row.lowerBound).toBeCloseTo(20 - ci, 9);
    expect(JSON.parse(row.recentScores)).toEqual({
      v: 2,
      scoring: "raw",
      lives: [
        [10, 600],
        [20, 600],
        [30, 600],
      ],
    });
  });

  it("stores a missing interval as null", () => {
    const row = toRatingsRow(addLife(EMPTY_RATING_STATE, minute(5)));
    expect(row.ci).toBeNull();
    expect(row.lowerBound).toBeNull();
  });

  it("has nothing to write before the first life", () => {
    expect(() => toRatingsRow(EMPTY_RATING_STATE)).toThrow(RangeError);
  });

  it("refuses to continue a window scored differently", () => {
    const state = addLife(addLife(EMPTY_RATING_STATE, minute(1)), minute(2));
    const on = scoringKey({ ...DEFAULT_NORMALIZATION, enabled: true });
    expect(scoringKey(DEFAULT_NORMALIZATION)).toBe(RAW_SCORING);
    expect(on).toBe("norm:600:0.9:2");
    expect(fromRatingsRow(toRatingsRow(state), undefined, on)).toBeNull();
    expect(fromRatingsRow(toRatingsRow(state, undefined, on), undefined, on)).toEqual(state);
    expect(fromRatingsRow(toRatingsRow(state, undefined, on))).toBeNull();
  });

  it("asks for a rebuild of a window from before points per minute", () => {
    const old = JSON.stringify({ v: 1, scoring: "raw", scores: [10, 20] });
    expect(decodeWindow(old)).toBeNull();
    expect(fromRatingsRow({ nLives: 2, aliveTicks: 0, recentScores: old })).toBeNull();
  });

  it("rejects malformed stored windows", () => {
    for (const bad of [
      "[1,2]",
      "{}",
      '{"v":3,"scoring":"raw","lives":[]}',
      '{"v":2,"lives":[]}',
      '{"v":2,"scoring":"raw","scores":[]}',
      '{"v":2,"scoring":"raw","lives":[[1,"2"]]}',
      '{"v":2,"scoring":"raw","lives":[[1]]}',
      '{"v":2,"scoring":"raw","lives":[null]}',
      "null",
    ]) {
      expect(() => decodeWindow(bad)).toThrow(TypeError);
    }
    expect(() => decodeWindow("{")).toThrow(SyntaxError);
    expect(() =>
      fromRatingsRow({ nLives: 1, aliveTicks: 1, recentScores: encodeWindow([minute(1e300)]) }),
    ).toThrow(RangeError);
    expect(decodeWindow(encodeWindow([minute(0.1), { score: -2, ticks: 1 }]))).toEqual({
      scoring: "raw",
      lives: [minute(0.1), { score: -2, ticks: 1 }],
    });
  });
});
