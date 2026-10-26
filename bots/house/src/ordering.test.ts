import { describe, expect, it } from "vitest";
import { RANKED } from "./index.ts";
import { runMatch, summarize } from "./match.ts";

/**
 * A CI-sized slice of `scripts/bench.ts`: real engine matches, four snakes of each ranked bot,
 * respawn on death. Strength is the mean score per snake slot, which counts dying often against
 * a bot; score per life is printed too but not asserted (hard dies about twice as often as
 * medium, so per life the two are close). Over 120 seeds, every window of 6 consecutive
 * matches was ordered, with hard ≥ 1.19× medium.
 */
const MATCHES = 6;
const TICKS = 1500;
const LINEUP = [...RANKED, ...RANKED, ...RANKED, ...RANKED];

describe("house bot strength", () => {
  it("orders easy < medium < hard by score per slot", { timeout: 60_000 }, async ({ annotate }) => {
    const results = Array.from({ length: MATCHES }, (_, m) =>
      runMatch({ seed: 1000 + m, lineup: LINEUP, ticks: TICKS }),
    );
    const summary = summarize(results);
    const report = RANKED.map((bot) => {
      const s = summary[bot];
      if (!s) throw new Error(`no results for ${bot}`);
      return `${bot}: per slot ${s.perSlot.toFixed(0)}, per life ${s.perLife.toFixed(0)}, deaths/slot ${s.deathsPerSlot.toFixed(1)}`;
    }).join("; ");
    await annotate(report);
    const perSlot = RANKED.map((bot) => summary[bot]?.perSlot ?? 0);
    expect(
      [...perSlot].sort((a, b) => a - b),
      report,
    ).toEqual(perSlot);
    expect(new Set(perSlot).size).toBe(RANKED.length);
  });
});
