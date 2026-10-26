/**
 * Smoke test: your bot loads in the real sandbox and plays real engine matches without throwing
 * or running over budget. It does not judge the strategy; `zerosnake test` adds qualification
 * (beat the `easy` house bot) and `zerosnake sim` lets you watch.
 */
import { checkSource } from "@zerosnake/sandbox";
import { beforeAll, describe, expect, it } from "vitest";
import { BUDGET, bundleBot, playMatch } from "./match.ts";

let bundle = "";
beforeAll(async () => {
  bundle = await bundleBot();
});

describe("bot", () => {
  it("bundles into code the sandbox accepts", () => {
    expect(bundle.length).toBeGreaterThan(0);
    // The server rejects bundles over 256 KB.
    expect(bundle.length).toBeLessThan(256 * 1024);
    // `async` and BigInt literals are rejected before the bot ever runs.
    expect(checkSource(bundle)).toBeNull();
  });

  it.each([1, 2, 3])(
    "plays seed %i against house bots without errors or timeouts",
    async (seed) => {
      const result = await playMatch(bundle, {
        seed,
        ticks: 1000,
        opponents: ["easy", "medium", "hard", "chaos"],
      });
      expect(result.problems).toEqual([]);
      const faults = result.lives.filter((l) => l.cause === "error" || l.cause === "timeout");
      expect(faults.map((l) => `tick ${l.tick}: ${l.cause}: ${l.error}`)).toEqual([]);
      // Stay well inside the per-tick budget: other bots in view make ticks more expensive.
      expect(result.maxInterrupts).toBeLessThanOrEqual(BUDGET.interrupts / 2);
      expect(result.maxWork).toBeLessThanOrEqual(BUDGET.work / 2);
    },
  );

  it("does not drive into the wall when alone in the arena", async () => {
    const result = await playMatch(bundle, { seed: 7, ticks: 1000 });
    expect(result.problems).toEqual([]);
    expect(result.lives.map((l) => l.cause)).not.toContain("wall");
  });
});
