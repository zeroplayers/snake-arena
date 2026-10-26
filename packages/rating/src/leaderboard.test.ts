import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareRated, leaderboard, type Rated } from "./leaderboard.ts";

const row = (id: string, mean: number, ci: number | null, lives: number): Rated => ({
  id,
  mean,
  ci,
  lives,
});

describe("leaderboard", () => {
  it("leaves out versions under the threshold", () => {
    const rows = [row("a", 10, 1, 29), row("b", 5, 1, 30)];
    expect(leaderboard(rows).map((r) => r.id)).toEqual(["b"]);
    expect(leaderboard(rows, { minLives: 1 }).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("orders by mean, then narrower interval, then more lives, then id", () => {
    const rows = [
      row("e", 50, 5, 40),
      row("d", 90, 5, 40),
      row("c", 90, 2, 40),
      row("b", 90, 2, 200),
      row("a", 90, 2, 200),
    ];
    expect(leaderboard(rows).map((r) => [r.id, r.rank])).toEqual([
      ["a", 1],
      ["b", 1],
      ["c", 3],
      ["d", 4],
      ["e", 5],
    ]);
  });

  it("puts unknown intervals after known ones", () => {
    const rows = [row("a", 1, null, 30), row("b", 1, Infinity, 31), row("c", 1, 1e9, 30)];
    expect(leaderboard(rows).map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("keeps the rows' other fields", () => {
    const [top] = leaderboard([{ ...row("v1", 1, 1, 30), botName: "noodle", author: "alice" }]);
    expect(top).toEqual({
      id: "v1",
      mean: 1,
      ci: 1,
      lives: 30,
      botName: "noodle",
      author: "alice",
      rank: 1,
    });
  });

  const rated = fc.record({
    id: fc.string({ maxLength: 4 }),
    mean: fc.integer({ min: 0, max: 5 }),
    ci: fc.option(fc.integer({ min: 0, max: 3 })),
    lives: fc.integer({ min: 25, max: 35 }),
  });

  it("is sorted, ranked consistently and independent of input order", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(rated, { selector: (r) => r.id, maxLength: 30 }),
        fc.nat(),
        (rows, seed) => {
          const board = leaderboard(rows);
          const shuffled = [...rows].sort(
            (a, b) => ((hash(a.id) ^ seed) % 7) - ((hash(b.id) ^ seed) % 7),
          );
          expect(leaderboard(shuffled)).toEqual(board);
          expect(board.length).toBe(rows.filter((r) => r.lives >= 30).length);
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

function hash(s: string): number {
  let h = 7;
  for (const c of s) h = (h * 31 + (c.codePointAt(0) ?? 0)) | 0;
  return Math.abs(h);
}
