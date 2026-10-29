import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIMITS } from "@zerosnake/checks";
import { describe, expect, it } from "vitest";
import {
  BATCH_CPU_SHARE,
  batchTicks,
  DO_CPU_LIMIT_MS,
  ENGINE_TICK_MS,
  HOUSE_BOT_TICK_MS,
  HOUSE_LIFE_START_MS,
  MAX_BATCH_TICKS,
  MAX_BUNDLE_BYTES,
  ROOM_CPU_BUDGET_MS,
  WORST_BOT_TICK_MS,
  WORST_LIFE_START_MS,
} from "./limits.ts";
import { houseFill, houseLabel, houseToRetire } from "./room/house.ts";

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

  it("counts native house bots at their own cost, not a sandboxed bot's", () => {
    // One deployed bot and 19 house bots, all starting: ~16× longer than 20 sandboxed bots.
    expect(batchTicks(1, 1, ROOM_CPU_BUDGET_MS, 19, 19)).toBe(397);
    expect(batchTicks(1, 0, ROOM_CPU_BUDGET_MS, 19, 0)).toBe(414);
    const ticks = batchTicks(1, 1, ROOM_CPU_BUDGET_MS, 19, 19);
    const worst =
      ticks * (WORST_BOT_TICK_MS + 19 * HOUSE_BOT_TICK_MS + ENGINE_TICK_MS) +
      WORST_LIFE_START_MS +
      19 * HOUSE_LIFE_START_MS;
    expect(worst).toBeLessThanOrEqual(ROOM_CPU_BUDGET_MS * BATCH_CPU_SHARE - 1000);
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
  it("fills every free slot with house bots of mixed strength", () => {
    const fill = houseFill([{ author: "a" }, { author: "b" }], 20, 7);
    expect(fill).toHaveLength(18);
    expect(fill.slice(0, 5).map((e) => [e.lifeId, e.author, e.house])).toEqual([
      ["house-medium-7-0", "house:medium", "medium"],
      ["house-easy-7-1", "house:easy", "easy"],
      ["house-hard-7-2", "house:hard", "hard"],
      ["house-chaos-7-3", "house:chaos", "chaos"],
      ["house-medium-7-4", "house:medium#2", "medium"],
    ]);
  });

  it("gives every house bot its own author, so each instance has a name", () => {
    const fill = houseFill([], 20, 0);
    const kinds = ["medium", "easy", "hard", "chaos"];
    expect(fill.map((e) => e.author)).toEqual([
      ...kinds.map((k) => `house:${k}`),
      ...[2, 3, 4, 5].flatMap((n) => kinds.map((k) => `house:${k}#${n}`)),
    ]);
    expect(new Set(fill.map((e) => e.author)).size).toBe(20);
  });

  it("never reuses the id or the author of a life present (a second fill at the same tick)", () => {
    const first = houseFill([{ author: "a" }], 5, 0);
    const second = houseFill([{ author: "b" }, ...first], 6, 0);
    // One of each kind: medium again. `house-medium-0-0` is taken by the first fill, and so is
    // the author `house:medium`.
    expect(second.map((e) => [e.lifeId, e.author])).toEqual([
      ["house-medium-0-1", "house:medium#2"],
    ]);
    expect(new Set([...first, ...second].map((e) => e.lifeId)).size).toBe(5);
  });

  it("replaces dead house snakes with the kinds the room has fewest of", () => {
    // A full room lost a chaos and both hards: the mix comes back, not more mediums.
    const present = [
      ...["u1", "u2", "u3"],
      ...["house:medium", "house:medium#2", "house:easy", "house:easy#2", "house:chaos#2"],
    ].map((author) => ({ author }));
    expect(houseFill(present, 11, 50).map((e) => e.author)).toEqual([
      "house:hard",
      "house:hard#2",
      "house:chaos",
    ]);
  });

  it("adds nothing when the room is full", () => {
    const full = Array.from({ length: 20 }, (_, n) => ({ author: `u${n}` }));
    expect(houseFill(full, 20, 0)).toEqual([]);
    expect(houseFill([{ author: "a" }, { author: "b" }], 3, 0)).toHaveLength(1);
  });
});

describe("houseToRetire", () => {
  const snake = (lifeId: string, mass: number, startTick: number) => ({ lifeId, mass, startTick });

  it("retires the smallest house snakes, then the youngest, then by id", () => {
    const house = [
      snake("big", 90, 0),
      snake("small-old", 12, 10),
      snake("small-young", 12, 400),
      snake("tiny-b", 5, 0),
      snake("tiny-a", 5, 0),
    ];
    expect(houseToRetire(house, 4)).toEqual(["tiny-a", "tiny-b", "small-young", "small-old"]);
    expect(houseToRetire(house, 1)).toEqual(["tiny-a"]);
  });

  it("retires none when nothing has to make way", () => {
    expect(houseToRetire([snake("h", 10, 0)], 0)).toEqual([]);
    expect(houseToRetire([snake("h", 10, 0)], -3)).toEqual([]);
  });
});

describe("houseLabel", () => {
  it("numbers the second and later copies of a kind", () => {
    expect(houseLabel("house:medium", "medium")).toBe("medium");
    expect(houseLabel("house:medium#2", "medium")).toBe("medium #2");
    expect(houseLabel("house:chaos#12", "chaos")).toBe("chaos #12");
  });
});
