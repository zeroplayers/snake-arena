import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareRated, leaderboard, lowerBound, type RatedVersion } from "./leaderboard.ts";
import { addLife, EMPTY_RATING_STATE, rate } from "./rating.ts";

function row(
  versionId: string,
  mean: number,
  ci: number | null,
  nLives: number,
  o: Partial<RatedVersion> = {},
): RatedVersion {
  return { versionId, botId: versionId, status: "ready", mean, ci, nLives, ...o };
}

const ids = (rows: { versionId: string }[]) => rows.map((r) => r.versionId);

describe("leaderboard", () => {
  it("leaves out versions under the threshold", () => {
    const rows = [row("a", 10, 1, 29), row("b", 5, 1, 30)];
    expect(ids(leaderboard(rows))).toEqual(["b"]);
    expect(ids(leaderboard(rows, { minLives: 1 }))).toEqual(["a", "b"]);
  });

  it("ranks only ready versions", () => {
    const rows = [
      row("archived", 100, 1, 200, { status: "archived" }),
      row("rejected", 100, 1, 200, { status: "rejected" }),
      row("validating", 100, 1, 200, { status: "validating" }),
      row("ready", 1, 1, 200),
    ];
    expect(ids(leaderboard(rows))).toEqual(["ready"]);
  });

  it("lists a bot once, with its best version", () => {
    const rows = [
      row("v1", 50, 5, 200, { botId: "noodle" }),
      row("v2", 80, 5, 200, { botId: "noodle" }),
      row("w1", 60, 5, 200, { botId: "worm" }),
    ];
    expect(leaderboard(rows).map((r) => [r.versionId, r.rank])).toEqual([
      ["v2", 1],
      ["w1", 2],
    ]);
  });

  it("orders by lower bound, then narrower interval, then more lives, then id", () => {
    const rows = [
      row("f", 100, 60, 40), // high mean, but lower bound 40
      row("e", 50, 5, 40),
      row("d", 90, 6, 40),
      row("c", 88, 4, 40),
      row("b", 88, 4, 200),
      row("a", 88, 4, 200),
    ];
    expect(leaderboard(rows).map((r) => [r.versionId, r.rank, r.lowerBound])).toEqual([
      ["a", 1, 84],
      ["b", 1, 84],
      ["c", 3, 84],
      ["d", 4, 84],
      ["e", 5, 45],
      ["f", 6, 40],
    ]);
  });

  it("puts versions without an interval last", () => {
    const rows = [row("a", 1e6, null, 30), row("b", 1e6, Infinity, 31), row("c", 1, 1e9, 30)];
    expect(ids(leaderboard(rows))).toEqual(["c", "b", "a"]);
    expect(lowerBound({ mean: 5, ci: null })).toBe(-Infinity);
  });

  it("keeps the rows' other fields", () => {
    const [top] = leaderboard([{ ...row("v1", 3, 1, 30), botName: "noodle", author: "alice" }]);
    expect(top).toEqual({
      ...row("v1", 3, 1, 30),
      botName: "noodle",
      author: "alice",
      rank: 1,
      lowerBound: 2,
    });
  });

  const rated = fc.record({
    versionId: fc.string({ maxLength: 4 }),
    botId: fc.constantFrom("a", "b", "c", "d", "e", "f"),
    status: fc.constantFrom("ready", "ready", "archived"),
    mean: fc.integer({ min: 0, max: 5 }),
    ci: fc.option(fc.integer({ min: 0, max: 3 })),
    nLives: fc.integer({ min: 25, max: 35 }),
  });

  it("is sorted, ranked consistently, one per bot and independent of input order", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(rated, { selector: (r) => r.versionId, maxLength: 30 }),
        fc.nat(),
        (rows, seed) => {
          const board = leaderboard(rows);
          const shuffled = [...rows].sort(
            (a, b) => ((hash(a.versionId) ^ seed) % 7) - ((hash(b.versionId) ^ seed) % 7),
          );
          expect(leaderboard(shuffled)).toEqual(board);
          const eligible = rows.filter((r) => r.status === "ready" && r.nLives >= 30);
          expect(board.map((r) => r.botId).sort()).toEqual(
            [...new Set(eligible.map((r) => r.botId))].sort(),
          );
          for (const [i, r] of board.entries()) {
            const prev = board[i - 1];
            if (!prev) {
              expect(r.rank).toBe(1);
              continue;
            }
            expect(compareRated(prev, r)).toBeLessThanOrEqual(0);
            expect(r.rank).toBe(compareRated(prev, r) === 0 ? prev.rank : i + 1);
          }
        },
      ),
    );
  });
});

describe("redeploy lottery", () => {
  // Life scores like the simulation's: lognormal with sd ≈ 3.5 × mean.
  const SIGMA = Math.sqrt(Math.log(1 + 3.5 ** 2));
  const next = rng(26);
  const life = (mean: number) => {
    const z = Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
    return mean * Math.exp(SIGMA * z - SIGMA ** 2 / 2);
  };
  const version = (id: string, mean: number, lives: number): RatedVersion => {
    let s = EMPTY_RATING_STATE;
    for (let i = 0; i < lives; i++) s = addLife(s, life(mean));
    const r = rate(s);
    return {
      versionId: id,
      botId: id,
      status: "ready",
      mean: r?.mean ?? 0,
      ci: r?.ci ?? null,
      nLives: lives,
    };
  };

  /**
   * The author redeploys the same code (true mean 1) K times, plays each version 30 lives and
   * keeps the one the leaderboard likes best; the rival is truly 1.5× better, with 200 lives.
   * Returns how often the lucky copy outranks the rival.
   */
  function lotteryWins(k: number, trials: number, byMean: boolean): number {
    let wins = 0;
    for (let t = 0; t < trials; t++) {
      const copies = Array.from({ length: k }, (_, i) => version(`copy${i}`, 1, 30));
      const best = byMean
        ? copies.reduce((a, b) => (b.mean > a.mean ? b : a))
        : (leaderboard(copies)[0] ?? copies[0]);
      const rival = version("rival", 1.5, 200);
      const top = byMean
        ? best && best.mean > rival.mean
          ? best
          : rival
        : leaderboard([best, rival].filter((x) => !!x))[0];
      if (top?.versionId !== "rival") wins++;
    }
    return wins / trials;
  }

  it("doesn't let the best of 10 lucky copies outrank a truly better bot", () => {
    expect(lotteryWins(10, 400, false)).toBeLessThan(0.1);
    // What ranking by the point mean would allow:
    expect(lotteryWins(10, 400, true)).toBeGreaterThan(0.5);
  });
});

function hash(s: string): number {
  let h = 7;
  for (const c of s) h = (h * 31 + (c.codePointAt(0) ?? 0)) | 0;
  return Math.abs(h);
}

/** mulberry32 */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
