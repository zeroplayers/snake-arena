import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createRatingConfig, DEFAULT_RATING_CONFIG, minRankedTicks } from "./config.ts";
import {
  addLife,
  createRatingState,
  EMPTY_RATING_STATE,
  MAX_LIFE_SCORE,
  type RatedLife,
  type RatingState,
  rate,
} from "./rating.ts";
import { ratioSummary, summarize, tQuantile } from "./stats.ts";

const score = fc.double({ min: 0, max: 1e6, noNaN: true });
const ticks = fc.integer({ min: 1, max: 864_000 });
const life = fc.record({ score, ticks });
const small = createRatingConfig({ window: 8, minMinutes: 3 });
const MINUTE = DEFAULT_RATING_CONFIG.ticksPerMinute;

function feed(lives: readonly RatedLife[], config = DEFAULT_RATING_CONFIG): RatingState {
  return lives.reduce((s, l) => addLife(s, l, config), EMPTY_RATING_STATE);
}

/** Lives of a minute each: the per-minute rating is then the plain mean score. */
const minutes = (xs: readonly number[]) => xs.map((x) => ({ score: x, ticks: MINUTE }));

/** Textbook ratio estimator, delta-method interval, for comparison. */
function naive(lives: readonly RatedLife[], z: number) {
  const n = lives.length;
  const y = lives.reduce((a, l) => a + l.score, 0);
  const t = lives.reduce((a, l) => a + l.ticks, 0);
  const r = y / t;
  const s2 = lives.reduce((a, l) => a + (l.score - r * l.ticks) ** 2, 0) / (n - 1);
  const se = Math.sqrt(s2 / n) / (t / n);
  return { mean: r * MINUTE, ci: tQuantile(z, n - 1) * se * MINUTE };
}

describe("rate", () => {
  it("has no rating before the first life", () => {
    expect(rate(EMPTY_RATING_STATE)).toBeNull();
  });

  it("gives a single life its own rate and an unbounded interval", () => {
    expect(rate(feed([{ score: 42, ticks: 1200 }]))).toEqual({
      mean: 21,
      ci: Infinity,
      n: 1,
      minutes: 2,
      lives: 1,
      totalMinutes: 2,
      ranked: false,
    });
  });

  it("is total score over total minutes alive", () => {
    const r = rate(
      feed([
        { score: 100, ticks: 600 },
        { score: 500, ticks: 5400 },
      ]),
    );
    expect(r?.mean).toBe(60);
    expect(r?.minutes).toBe(10);
  });

  it("is the mean with a t interval when every life lasts as long", () => {
    const r = rate(feed(minutes([1, 2, 3, 4])));
    expect(r?.mean).toBe(2.5);
    expect(r?.ci).toBeCloseTo((tQuantile(1.96, 3) * Math.sqrt(5 / 3)) / 2, 12);
  });

  it("agrees with the textbook formulas", () => {
    fc.assert(
      fc.property(fc.array(life, { minLength: 2, maxLength: 300 }), (lives) => {
        const r = rate(feed(lives));
        const want = naive(lives.slice(-200), 1.96);
        expect(r?.mean).toBeCloseTo(want.mean, 6);
        expect(r?.ci).toBeCloseTo(want.ci, 6);
      }),
    );
  });
});

describe("time weighting", () => {
  // A steady bot: 5-minute lives at 100 points per minute, 60 of them (5 hours).
  const steady = Array.from({ length: 60 }, () => ({ score: 500, ticks: 5 * MINUTE }));

  it("lets a very short life move the rating only by the time it lasted", () => {
    // Ate a pellet and died after 5 seconds: about 6 points per minute, for 50 ticks.
    const pellet = { score: 0.5, ticks: 50 };
    const before = rate(feed(steady))?.mean ?? 0;
    const after = rate(feed([...steady, pellet]))?.mean ?? 0;
    expect(before).toBe(100);
    expect(after).toBeLessThan(before);
    expect(before - after).toBeLessThan(0.3);
    // A 5-second life with a kill (50 points: 600 per minute) barely lifts it either.
    const lucky = rate(feed([...steady, { score: 50, ticks: 50 }]))?.mean ?? 0;
    expect(lucky - before).toBeLessThan(2);
    // Averaging per-life rates instead would let that one life add 8 points per minute.
    const rates = [...steady.map((l) => l.score / (l.ticks / MINUTE)), 600];
    expect(summarize(rates).mean - before).toBeGreaterThan(8);
  });

  it("gives a 24-hour life the weight of 24 hours, not of one life", () => {
    const short = Array.from({ length: 199 }, () => ({ score: 20, ticks: MINUTE }));
    const long = { score: 300 * 1440, ticks: 864_000 };
    const r = rate(feed([...short, long]));
    // 199 minutes at 20 and 1440 at 300: Σ score / Σ minutes, not the mean of 200 lives.
    expect(r?.mean).toBeCloseTo((199 * 20 + 1440 * 300) / (199 + 1440), 9);
  });

  it("is the same however a stretch of play is cut into lives at the same rate", () => {
    fc.assert(
      fc.property(fc.array(ticks, { minLength: 2, maxLength: 50 }), (ts) => {
        const r = rate(feed(ts.map((t) => ({ score: t / 10, ticks: t }))));
        expect(r?.mean).toBeCloseTo(60, 9);
        expect(r?.ci).toBeLessThan(1e-6);
      }),
    );
  });
});

describe("window eviction", () => {
  it("keeps exactly the last `window` lives and counts every life and tick", () => {
    fc.assert(
      fc.property(fc.array(life, { maxLength: 40 }), (lives) => {
        const s = feed(lives, small);
        expect(s.window).toEqual(lives.slice(-small.window));
        expect(s.lives).toBe(lives.length);
        expect(s.ticks).toBe(lives.reduce((t, l) => t + l.ticks, 0));
        if (lives.length) expect(rate(s, small)?.n).toBe(Math.min(lives.length, small.window));
      }),
    );
  });

  it("moves a full window of one-minute lives by (new − evicted) / window", () => {
    fc.assert(
      fc.property(fc.array(score, { minLength: 8, maxLength: 30 }), score, (xs, x) => {
        const before = feed(minutes(xs), small);
        const evicted = before.window[0]?.score ?? 0;
        const after = addLife(before, { score: x, ticks: MINUTE }, small);
        const delta = (rate(after, small)?.mean ?? 0) - (rate(before, small)?.mean ?? 0);
        expect(delta).toBeCloseTo((x - evicted) / small.window, 6);
      }),
    );
  });

  it("leaves the old state untouched", () => {
    const s = feed(minutes([1, 2, 3]), small);
    const copy = { ...s, window: [...s.window] };
    addLife(s, { score: 4, ticks: 10 }, small);
    expect(s).toEqual(copy);
  });

  it("trims to a smaller window when the config shrinks", () => {
    const s = feed(minutes([1, 2, 3, 4, 5, 6, 7, 8]), small);
    const four = createRatingConfig({ window: 4 });
    expect(rate(s, four)?.mean).toBe(6.5);
    expect(addLife(s, { score: 9, ticks: MINUTE }, four).window.map((l) => l.score)).toEqual([
      6, 7, 8, 9,
    ]);
  });

  it("rebuilds the same state from stored lives", () => {
    fc.assert(
      fc.property(fc.array(life, { minLength: 1, maxLength: 40 }), (lives) => {
        const total = lives.reduce((t, l) => t + l.ticks, 0);
        expect(createRatingState(lives.slice(-8), lives.length, total, small)).toEqual(
          feed(lives, small),
        );
      }),
    );
  });
});

describe("leaderboard threshold", () => {
  it("ranks a version once its lives add up to `minMinutes`, with two lives at least", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 120 }),
        fc.array(fc.integer({ min: 1, max: 3 * MINUTE }), { minLength: 1, maxLength: 80 }),
        (min, ts) => {
          const config = createRatingConfig({ minMinutes: min });
          const s = feed(
            ts.map((t) => ({ score: t, ticks: t })),
            config,
          );
          const total = ts.reduce((a, t) => a + t, 0);
          expect(rate(s, config)?.ranked).toBe(ts.length >= 2 && total >= min * MINUTE);
        },
      ),
    );
    expect(minRankedTicks(DEFAULT_RATING_CONFIG)).toBe(36_000);
  });

  it("counts evicted lives' time towards the threshold", () => {
    const config = createRatingConfig({ window: 4, minMinutes: 10 });
    const s = feed(minutes(Array.from({ length: 10 }, () => 1)), config);
    expect(rate(s, config)).toMatchObject({ n: 4, minutes: 4, lives: 10, totalMinutes: 10 });
    expect(rate(s, config)?.ranked).toBe(true);
  });

  it("doesn't rank a single long life, which has no interval", () => {
    const r = rate(feed([{ score: 1e6, ticks: 864_000 }]));
    expect(r).toMatchObject({ totalMinutes: 1440, ranked: false, ci: Infinity });
  });
});

describe("interval", () => {
  it("narrows as identical batches of lives pile up", () => {
    const batch = [
      { score: 10, ticks: 100 },
      { score: 200, ticks: 3000 },
      { score: 30, ticks: 900 },
      { score: 4000, ticks: 9000 },
    ];
    const ci = (k: number) => rate(feed(Array.from({ length: k }, () => batch).flat()))?.ci ?? 0;
    expect(ci(1)).toBeGreaterThan(ci(2));
    expect(ci(2)).toBeGreaterThan(ci(8));
    expect(ci(8)).toBeGreaterThan(ci(50));
  });

  it("uses Student's t: wide with few lives, normal with many", () => {
    expect(tQuantile(1.96, 1)).toBeGreaterThan(11);
    expect(tQuantile(1.96, 2)).toBeCloseTo(4.303, 1);
    expect(tQuantile(1.96, 3)).toBeCloseTo(3.182, 2);
    expect(tQuantile(1.96, 10)).toBeCloseTo(2.228, 3);
    expect(tQuantile(1.96, 29)).toBeCloseTo(2.045, 3);
    expect(tQuantile(1.96, 199)).toBeCloseTo(1.972, 3);
    expect(tQuantile(1.96, 0)).toBe(Infinity);
  });
});

describe("monotonicity", () => {
  it("rates pointwise better lives of the same length at least as high", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(life, fc.double({ min: 0, max: 1e3, noNaN: true })), {
          minLength: 1,
          maxLength: 50,
        }),
        (pairs) => {
          const lo = rate(
            feed(
              pairs.map(([l]) => l),
              small,
            ),
            small,
          );
          const hi = rate(
            feed(
              pairs.map(([l, d]) => ({ ...l, score: l.score + d })),
              small,
            ),
            small,
          );
          const a = lo?.mean ?? 0;
          expect(hi?.mean ?? 0).toBeGreaterThanOrEqual(a - 1e-9 * Math.abs(a));
        },
      ),
    );
  });
});

describe("numeric stability", () => {
  it("gives a window at one constant rate a zero-width interval", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        fc.array(fc.integer({ min: 1, max: 864_000 }), { minLength: 2, maxLength: 200 }),
        (perTick, ts) => {
          const r = rate(feed(ts.map((t) => ({ score: perTick * t, ticks: t }))));
          expect(r?.mean).toBeCloseTo(perTick * MINUTE, 0);
          expect(r?.ci).toBeLessThanOrEqual(1e-6 * Math.max(1, Math.abs(perTick * MINUTE)));
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
        fc.array(life, { minLength: 2, maxLength: 50 }),
        fc.double({ min: 1e-3, max: 1e3, noNaN: true }),
        (lives, k) => {
          const a = rate(feed(lives));
          const b = rate(feed(lives.map((l) => ({ ...l, score: l.score * k }))));
          expect(b?.mean).toBeCloseTo((a?.mean ?? 0) * k, 3);
          expect(b?.ci).toBeCloseTo((a?.ci ?? 0) * k, 3);
        },
      ),
    );
  });

  it("doesn't drift over a long run of updates", () => {
    let s = EMPTY_RATING_STATE;
    const all: RatedLife[] = [];
    for (let i = 0; i < 20_000; i++) {
      const l = { score: ((i * 7919) % 10_007) * 123.456 + 1e7, ticks: 1 + ((i * 104_729) % 9973) };
      all.push(l);
      s = addLife(s, l);
    }
    const r = rate(s);
    const last = all.slice(-200);
    const fresh = ratioSummary(
      last.map((l) => l.score * MINUTE),
      last.map((l) => l.ticks),
    );
    expect(r?.mean).toBe(fresh.ratio);
    expect(r?.ci).toBe(tQuantile(1.96, 199) * fresh.se);
    expect(r?.lives).toBe(20_000);
  });
});

describe("input checks", () => {
  it("rejects scores that aren't finite or are out of range", () => {
    for (const bad of [Number.NaN, Infinity, -Infinity, MAX_LIFE_SCORE * 2, 1e308]) {
      expect(() => addLife(EMPTY_RATING_STATE, { score: bad, ticks: 10 })).toThrow(RangeError);
      expect(() =>
        createRatingState([
          { score: 1, ticks: 1 },
          { score: bad, ticks: 1 },
        ]),
      ).toThrow(RangeError);
    }
    const r = rate(feed(minutes([MAX_LIFE_SCORE, -MAX_LIFE_SCORE, MAX_LIFE_SCORE])));
    expect(r?.mean).toBeCloseTo(MAX_LIFE_SCORE / 3, -1);
  });

  it("rejects lengths that aren't whole ticks, and counts 0 as 1", () => {
    for (const bad of [Number.NaN, -1, 0.5, Infinity, 2e9]) {
      expect(() => addLife(EMPTY_RATING_STATE, { score: 1, ticks: bad })).toThrow(RangeError);
    }
    expect(addLife(EMPTY_RATING_STATE, { score: 1, ticks: 0 }).window).toEqual([
      { score: 1, ticks: 1 },
    ]);
  });

  it("rejects a life count below the stored lives", () => {
    expect(() => createRatingState(minutes([1, 2, 3]), 2)).toThrow(RangeError);
    expect(() => createRatingState(minutes([1]), 1, -1)).toThrow(RangeError);
  });

  it("rejects configs it can't work with", () => {
    expect(() => createRatingConfig({ window: 1 })).toThrow(RangeError);
    expect(() => createRatingConfig({ minMinutes: -1 })).toThrow(RangeError);
    expect(() => createRatingConfig({ z: 0 })).toThrow(RangeError);
    expect(() => createRatingConfig({ ticksPerMinute: 0 })).toThrow(RangeError);
    expect(createRatingConfig()).toEqual({
      window: 200,
      minMinutes: 60,
      z: 1.96,
      ticksPerMinute: 600,
    });
  });
});
