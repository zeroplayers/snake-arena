// Runtime of the whole suite on a few bots. Opt-in: BENCH=1 pnpm vitest run packages/checks/src/bench.test.ts
import { expect, it } from "vitest";
import { runChecks } from "./index.ts";
import { BAD_BOTS, easyWith, houseBundle, input, longBody } from "./testing/fixtures.ts";

it.runIf(process.env.BENCH)(
  "measures the suite",
  async () => {
    const bots: [string, string][] = [
      ["easy", await houseBundle("easy")],
      ["medium", await houseBundle("medium")],
      ["hard", await houseBundle("hard")],
      ["suicidal", BAD_BOTS.suicidal],
      ["infinite loop", BAD_BOTS.infiniteLoop],
      // About 90% of the op budget on every tick: the slowest bot that still passes.
      ["near budget", await easyWith("let x = 0; for (let i = 0; i < 40000; i++) x += i * 0.5")],
      // Within the op budget but slow per op (#60): only the wall-clock cap stops it in Node.
      ["8-stmt body", await longBody(8, 30_000)],
      ["300-stmt body", await longBody(300, 20_000)],
    ];
    await runChecks(input(bots[0]?.[1] ?? "")); // warm up, and fill the baseline cache
    for (const [name, bundle] of bots) {
      const t0 = performance.now();
      const report = await runChecks(input(bundle));
      const ms = performance.now() - t0;
      console.log(
        `${name.padEnd(14)} ${(ms / 1000).toFixed(2).padStart(6)} s  passed=${report.passed}  peak ops=${report.run.stats.peakInterrupts}  ${report.run.overrun?.limit ?? report.run.fault?.reason ?? ""}`,
      );
      // The 60 s cap is read between ticks, so a slow tick can overshoot it a little.
      expect(ms).toBeLessThan(75_000);
    }
  },
  600_000,
);
