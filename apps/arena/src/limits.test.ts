import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIMITS } from "@zerosnake/checks";
import { describe, expect, it } from "vitest";
import {
  BATCH_CPU_SHARE,
  batchTicks,
  DO_CPU_LIMIT_MS,
  ENGINE_TICK_MS,
  MAX_BATCH_TICKS,
  MAX_BUNDLE_BYTES,
  ROOM_CPU_BUDGET_MS,
  WORST_BOT_TICK_MS,
  WORST_LIFE_START_MS,
} from "./limits.ts";
import { houseFill } from "./room/house.ts";

describe("batchTicks", () => {
  it("fits the worst case in half the room's CPU budget", () => {
    for (const bots of [1, 5, 10, 20]) {
      for (const starts of [0, bots]) {
        const ticks = batchTicks(bots, starts);
        const worst =
          ticks * (bots * WORST_BOT_TICK_MS + ENGINE_TICK_MS) + starts * WORST_LIFE_START_MS;
        expect(worst).toBeLessThanOrEqual(ROOM_CPU_BUDGET_MS * BATCH_CPU_SHARE);
      }
    }
  });

  it("gives the numbers in the PR", () => {
    expect(WORST_BOT_TICK_MS).toBe(27);
    expect(WORST_LIFE_START_MS).toBe(567);
    expect(batchTicks(20, 0)).toBe(25);
    expect(batchTicks(20, 20)).toBe(4);
    expect(batchTicks(10, 0)).toBe(51);
    expect(batchTicks(5, 0)).toBe(102);
    expect(batchTicks(5, 5)).toBe(81);
    expect(batchTicks(0, 0)).toBe(MAX_BATCH_TICKS);
  });
});

it("sizes instrumentation for the largest bundle the checks accept", () => {
  expect(LIMITS.maxBundleBytes).toBeLessThanOrEqual(MAX_BUNDLE_BYTES);
});

describe("DO_CPU_LIMIT_MS", () => {
  it("is the Worker's limits.cpu_ms in every environment of wrangler.jsonc", () => {
    const text = readFileSync(join(import.meta.dirname, "../wrangler.jsonc"), "utf8");
    // JSONC: drop comments (none of the config's strings contain `//` or `/*`) and trailing commas.
    const config = JSON.parse(
      text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
        .replace(/,(\s*[}\]])/g, "$1"),
    ) as { limits?: { cpu_ms?: number }; env: Record<string, { limits?: { cpu_ms?: number } }> };
    expect(config.limits?.cpu_ms).toBe(DO_CPU_LIMIT_MS);
    for (const env of Object.values(config.env)) expect(env.limits?.cpu_ms).toBe(DO_CPU_LIMIT_MS);
    // The room's budget leaves the hard limit far behind (see ROOM_CPU_BUDGET_MS).
    expect(ROOM_CPU_BUDGET_MS * 5).toBeLessThanOrEqual(DO_CPU_LIMIT_MS);
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
