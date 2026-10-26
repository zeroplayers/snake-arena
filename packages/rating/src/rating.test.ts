import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createRatingConfig, DEFAULT_RATING_CONFIG } from "./config.ts";
import {
  addLife,
  createRatingState,
  EMPTY_RATING_STATE,
  type RatingState,
  rate,
} from "./rating.ts";
import { summarize } from "./stats.ts";

const score = fc.double({ min: 0, max: 1e6, noNaN: true });
const small = createRatingConfig({ window: 8, minLives: 3 });

function feed(xs: readonly number[], config = DEFAULT_RATING_CONFIG): RatingState {
  return xs.reduce((s, x) => addLife(s, x, config), EMPTY_RATING_STATE);
}

/** Textbook mean and CI, for comparison. */
function naive(xs: readonly number[], z: number) {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return { mean, ci: (z * Math.sqrt(variance)) / Math.sqrt(n) };
}

describe("rate", () => {
  it("has no rating before the first life", () => {
    expect(rate(EMPTY_RATING_STATE)).toBeNull();
  });

  it("gives a single life an unbounded interval", () => {
    expect(rate(feed([42]))).toEqual({ mean: 42, ci: Infinity, n: 1, lives: 1, ranked: false });
  });

  it("is the mean with a normal-approximation interval", () => {
    const r = rate(feed([1, 2, 3, 4]));
    expect(r?.mean).toBe(2.5);
    expect(r?.ci).toBeCloseTo((1.96 * Math.sqrt(5 / 3)) / 2, 12);
  });

  it("agrees with the textbook formulas", () => {
    fc.assert(
      fc.property(fc.array(score, { minLength: 2, maxLength: 300 }), (xs) => {
        const r = rate(feed(xs));
        const want = naive(xs.slice(-200), 1.96);
        expect(r?.mean).toBeCloseTo(want.mean, 6);
        expect(r?.ci).toBeCloseTo(want.ci, 6);
      }),
    );
  });
});

describe("window eviction", () => {
  it("keeps exactly the last `window` scores and counts every life", () => {
    fc.assert(
      fc.property(fc.array(score, { maxLength: 40 }), (xs) => {
        const s = feed(xs, small);
        expect(s.scores).toEqual(xs.slice(-small.window));
        expect(s.lives).toBe(xs.length);
        if (xs.length) expect(rate(s, small)?.n).toBe(Math.min(xs.length, small.window));
      }),
    );
  });

  it("moves a full window's mean by (new − evicted) / window", () => {
    fc.assert(
      fc.property(fc.array(score, { minLength: 8, maxLength: 30 }), score, (xs, x) => {
        const before = feed(xs, small);
        const evicted = before.scores[0] ?? 0;
        const delta =
          (rate(addLife(before, x, small), small)?.mean ?? 0) - (rate(before, small)?.mean ?? 0);
        expect(delta).toBeCloseTo((x - evicted) / small.window, 6);
      }),
    );
  });

  it("leaves the old state untouched", () => {
    const s = feed([1, 2, 3], small);
    const copy = { ...s, scores: [...s.scores] };
    addLife(s, 4, small);
    expect(s).toEqual(copy);
  });

  it("trims to a smaller window when the config shrinks", () => {
    const s = feed([1, 2, 3, 4, 5, 6, 7, 8], small);
    const four = createRatingConfig({ window: 4, minLives: 3 });
    expect(rate(s, four)?.mean).toBe(6.5);
    expect(addLife(s, 9, four).scores).toEqual([6, 7, 8, 9]);
  });

  it("rebuilds the same state from stored scores", () => {
    fc.assert(
      fc.property(fc.array(score, { minLength: 1, maxLength: 40 }), (xs) => {
        expect(createRatingState(xs.slice(-8), xs.length, small)).toEqual(feed(xs, small));
      }),
    );
  });
});

describe("leaderboard threshold", () => {
  it("ranks a version exactly from `minLives` lives on", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 60 }), fc.integer({ min: 1, max: 80 }), (min, n) => {
        const config = createRatingConfig({ minLives: min });
        const s = feed(
          Array.from({ length: n }, (_, i) => i),
          config,
        );
        expect(rate(s, config)?.ranked).toBe(n >= min);
      }),
    );
  });

  it("counts evicted lives towards the threshold", () => {
    const config = createRatingConfig({ window: 4, minLives: 10 });
    const s = feed(
      Array.from({ length: 10 }, () => 1),
      config,
    );
    expect(rate(s, config)).toMatchObject({ n: 4, lives: 10, ranked: true });
  });
});

describe("monotonicity", () => {
  it("rates pointwise better lives at least as high", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(score, fc.double({ min: 0, max: 1e3, noNaN: true })), {
          minLength: 1,
          maxLength: 50,
        }),
        (pairs) => {
          const lo =
            rate(
              feed(
                pairs.map(([x]) => x),
                small,
              ),
              small,
            )?.mean ?? 0;
          const hi =
            rate(
              feed(
                pairs.map(([x, d]) => x + d),
                small,
              ),
              small,
            )?.mean ?? 0;
          expect(hi).toBeGreaterThanOrEqual(lo - 1e-9 * Math.abs(lo));
        },
      ),
    );
  });

  it("raises the mean with a life above it while the window fills", () => {
    fc.assert(
      fc.property(
        fc.array(score, { minLength: 1, maxLength: 7 }),
        fc.double({ min: 0, max: 1e3, noNaN: true }),
        (xs, d) => {
          const before = rate(feed(xs, small), small)?.mean ?? 0;
          const after = rate(feed([...xs, before + d], small), small)?.mean ?? 0;
          expect(after).toBeGreaterThanOrEqual(before - 1e-9 * before);
        },
      ),
    );
  });

  it("narrows the interval as identical batches of lives pile up", () => {
    const batch = [10, 20, 30, 40];
    const ci = (k: number) => rate(feed(Array.from({ length: k }, () => batch).flat()))?.ci ?? 0;
    expect(ci(2)).toBeGreaterThan(ci(8));
    expect(ci(8)).toBeGreaterThan(ci(50));
  });
});

describe("numeric stability", () => {
  it("gives a constant window a zero-width interval", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e12, max: 1e12, noNaN: true }),
        fc.integer({ min: 2, max: 200 }),
        (x, n) => {
          const r = rate(feed(Array.from({ length: n }, () => x)));
          expect(r?.mean).toBeCloseTo(x, 0);
          expect(r?.ci).toBeLessThanOrEqual(1e-12 * Math.abs(x));
        },
      ),
    );
  });

  it("doesn't lose a small spread on top of a huge offset", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 100, noNaN: true }), { minLength: 2, maxLength: 200 }),
        (xs) => {
          const base = summarize(xs);
          const shifted = summarize(xs.map((x) => x + 1e9));
          expect(shifted.mean - 1e9).toBeCloseTo(base.mean, 4);
          expect(shifted.sd).toBeCloseTo(base.sd, 4);
        },
      ),
    );
  });

  it("scales with the scores", () => {
    fc.assert(
      fc.property(
        fc.array(score, { minLength: 2, maxLength: 50 }),
        fc.double({ min: 1e-3, max: 1e3, noNaN: true }),
        (xs, k) => {
          const a = rate(feed(xs));
          const b = rate(feed(xs.map((x) => x * k)));
          expect(b?.mean).toBeCloseTo((a?.mean ?? 0) * k, 3);
          expect(b?.ci).toBeCloseTo((a?.ci ?? 0) * k, 3);
        },
      ),
    );
  });

  it("doesn't drift over a long run of updates", () => {
    let s = EMPTY_RATING_STATE;
    const all: number[] = [];
    for (let i = 0; i < 20_000; i++) {
      const x = ((i * 7919) % 10_007) * 123.456 + 1e7;
      all.push(x);
      s = addLife(s, x);
    }
    const r = rate(s);
    const fresh = summarize(all.slice(-200));
    expect(r?.mean).toBe(fresh.mean);
    expect(r?.ci).toBe((1.96 * fresh.sd) / Math.sqrt(200));
    expect(r?.lives).toBe(20_000);
  });
});

describe("input checks", () => {
  it("rejects scores that aren't finite", () => {
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      expect(() => addLife(EMPTY_RATING_STATE, bad)).toThrow(RangeError);
    }
  });

  it("rejects a life count below the stored scores", () => {
    expect(() => createRatingState([1, 2, 3], 2)).toThrow(RangeError);
  });

  it("rejects configs it can't work with", () => {
    expect(() => createRatingConfig({ window: 1 })).toThrow(RangeError);
    expect(() => createRatingConfig({ minLives: 0 })).toThrow(RangeError);
    expect(() => createRatingConfig({ z: 0 })).toThrow(RangeError);
    expect(createRatingConfig()).toEqual({ window: 200, minLives: 30, z: 1.96 });
  });
});
