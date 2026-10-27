import { describe, expect, it } from "vitest";
import { runChecks } from "./index.ts";
import { houseBundle, input, templateBundle } from "./testing/fixtures.ts";

// Re-verification of #62 (H4): the sandbox's instrumenter broke on minified code (`=>` with no
// space after it, a function's first statement right after its `{`), so honest bots built with
// `minify: true` died at load. Each bot here must play exactly as its plain build does.
const QUICK = { seeds: [101, 202], ticks: 300 };

const bots: Record<string, (minify: boolean) => Promise<string>> = {
  easy: (minify) => houseBundle("easy", minify),
  medium: (minify) => houseBundle("medium", minify),
  hard: (minify) => houseBundle("hard", minify),
  chaos: (minify) => houseBundle("chaos", minify),
  template: templateBundle,
};

describe("minified bundles", () => {
  for (const [name, build] of Object.entries(bots)) {
    it(`${name} plays as its plain build does`, { timeout: 60_000 }, async () => {
      const minified = await build(true);
      expect(minified).not.toMatch(/\n\s/); // no indentation: really minified
      const [plain, small] = [
        await runChecks(input(await build(false)), QUICK),
        await runChecks(input(minified), QUICK),
      ];
      expect(small.load.error).toBeNull();
      expect(small.run.fault).toBeNull();
      expect(small.run.overrun).toBeNull();
      expect(small.run.seeds).toEqual(plain.run.seeds);
      expect(small.run.stats.timeoutTicks).toBe(0);
      expect(small.run.stats.errorTicks).toBe(0);
    });
  }
});
