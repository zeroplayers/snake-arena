import { describe, expect, it } from "vitest";
import {
  BATCH_CPU_SHARE,
  batchTicks,
  DO_CPU_LIMIT_MS,
  ENGINE_TICK_MS,
  MAX_BATCH_TICKS,
  WORST_BOT_TICK_MS,
  WORST_LIFE_START_MS,
} from "./limits.ts";
import { houseFill } from "./room/house.ts";

describe("batchTicks", () => {
  it("fits the worst case in half the DO CPU limit", () => {
    for (const bots of [1, 5, 10, 20]) {
      for (const starts of [0, bots]) {
        const ticks = batchTicks(bots, starts);
        const worst =
          ticks * (bots * WORST_BOT_TICK_MS + ENGINE_TICK_MS) + starts * WORST_LIFE_START_MS;
        expect(worst).toBeLessThanOrEqual(DO_CPU_LIMIT_MS * BATCH_CPU_SHARE);
      }
    }
  });

  it("gives the numbers in the PR", () => {
    expect(WORST_BOT_TICK_MS).toBe(27);
    expect(batchTicks(20, 0)).toBe(25);
    expect(batchTicks(20, 20)).toBe(15);
    expect(batchTicks(10, 0)).toBe(51);
    expect(batchTicks(5, 0)).toBe(102);
    expect(batchTicks(5, 5)).toBe(92);
    expect(batchTicks(0, 0)).toBe(MAX_BATCH_TICKS);
  });
});

describe("houseFill", () => {
  it("adds house bots of mixed strength until 5 distinct authors", () => {
    const fill = houseFill([{ author: "a" }, { author: "b" }], 20, 5, 7);
    expect(fill.map((e) => [e.lifeId, e.author, e.house])).toEqual([
      ["house-medium-7-0", "house:medium", "medium"],
      ["house-easy-7-1", "house:easy", "easy"],
      ["house-hard-7-2", "house:hard", "hard"],
    ]);
  });

  it("gives every house bot its own author", () => {
    const fill = houseFill([], 20, 5, 0);
    expect(fill.map((e) => e.author)).toEqual([
      "house:medium",
      "house:easy",
      "house:hard",
      "house:chaos",
      "house:medium#2",
    ]);
  });

  it("never reuses the id of a life present (a second fill at the same tick)", () => {
    const first = houseFill([{ author: "a" }], 20, 3, 0);
    const second = houseFill([{ author: "b" }, ...first], 20, 4, 0);
    // `house-medium-0-0` is taken by the first fill.
    expect(second.map((e) => e.lifeId)).toEqual(["house-medium-0-1"]);
    expect(new Set([...first, ...second].map((e) => e.lifeId)).size).toBe(3);
  });

  it("adds nothing when authors are enough or the room is full", () => {
    expect(
      houseFill(
        [1, 2, 3, 4, 5].map((n) => ({ author: `u${n}` })),
        20,
        5,
        0,
      ),
    ).toEqual([]);
    expect(houseFill([{ author: "a" }, { author: "b" }], 3, 5, 0)).toHaveLength(1);
  });
});
