import { beforeAll, describe, expect, it } from "vitest";
import { type CheckReport, formatReport, LIMITS, runChecks } from "./index.ts";
import { BAD_BOTS, botWithTick, easyWith, houseBundle, input } from "./testing/fixtures.ts";

// A full run (5 seeds × 1000 ticks) takes a few seconds; most tests use shorter matches so the
// suite doesn't starve the timing tests of other packages running in parallel.
const FULL = 60_000;
const QUICK = { seeds: [101, 202, 303], ticks: 400 };

describe("honest bots", () => {
  let medium: string;
  beforeAll(async () => {
    medium = await houseBundle("medium");
  });

  it(
    "pass with the default seeds and ticks",
    async () => {
      const first = await runChecks(input(medium));

      expect(first.passed).toBe(true);
      expect([first.limits, first.load, first.run, first.qualify].map((c) => c.status)).toEqual([
        "pass",
        "pass",
        "pass",
        "pass",
      ]);
      expect(first.seeds).toEqual([101, 202, 303, 404, 505]);
      expect(first.ticks).toBe(1000);
      expect(first.run.seeds.map((s) => s.ticks)).toEqual([1000, 1000, 1000, 1000, 1000]);
      expect(first.qualify.score).toBeGreaterThan(first.qualify.bar as number);
      expect(formatReport(first)).toContain("Checks passed");
    },
    FULL,
  );

  it("get the same report every time", async () => {
    const first = await runChecks(input(medium), QUICK);
    const second = await runChecks(input(medium), QUICK);
    expect(first.passed).toBe(true);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it(
    "easy itself qualifies: a tie passes, and easy scores the same in the sandbox as natively",
    async () => {
      const report = await runChecks(input(await houseBundle("easy")), QUICK);
      expect(report.passed).toBe(true);
      expect(report.qualify.score).toBe(report.qualify.bar);
      expect(report.qualify.lives).toBe(report.qualify.barLives);
      for (const s of report.qualify.perSeed) expect(s.score).toBe(s.bar);
    },
    FULL,
  );

  it(
    "survive a few exceptions, reported as warnings",
    async () => {
      const report = await runChecks(
        input(await easyWith("if (state.tick % 97 === 13) throw new Error('rare')")),
        QUICK,
      );
      expect(report.run.status).toBe("pass");
      expect(report.run.stats.errorTicks).toBeGreaterThan(0);
      expect(report.run.stats.firstError).toMatchObject({ seed: 101, tick: 13 });
      expect(report.run.warnings.join("\n")).toMatch(/threw on \d+ tick\(s\).*Error: rare/);
    },
    FULL,
  );
});

describe("bad bots are rejected with a clear reason", () => {
  const rejected = (report: CheckReport) => {
    expect(report.passed).toBe(false);
    return formatReport(report);
  };

  it("an infinite loop: timeout death", async () => {
    const report = await runChecks(input(BAD_BOTS.infiniteLoop));
    const text = rejected(report);
    expect(report.run.status).toBe("fail");
    expect(report.run.fault).toMatchObject({
      seed: 101,
      life: 1,
      lifeTick: 23,
      fault: "timeout",
      reason: "timeouts",
      message: "3 ticks in a row over budget",
    });
    // The fatal streak is the death, not a warning on top of it.
    expect(report.run.stats.timeoutTicks).toBe(0);
    expect(report.run.warnings).toEqual([]);
    expect(report.qualify.status).toBe("skip");
    expect(text).toContain("✗ Runs      killed on seed 101 at tick 23 (life 1): 3 ticks in a row");
    expect(text).toContain("a loop that never ends");
  });

  it("an exception every tick: error death, with the bot's own message and location", async () => {
    const report = await runChecks(input(BAD_BOTS.exception));
    rejected(report);
    expect(report.run.fault).toMatchObject({ fault: "error", reason: "errors" });
    expect(report.run.fault?.message).toContain("Error: boom");
    expect(report.run.summary).toContain("Error: boom (at bot.js:2:");
    expect(report.run.summary).not.toContain("\n");
    expect(report.run.stats).toMatchObject({ errorTicks: 0, firstError: null });
  });

  it("memory that grows every tick: oom death", async () => {
    const report = await runChecks(input(BAD_BOTS.oom));
    rejected(report);
    expect(report.run.fault).toMatchObject({ fault: "error", reason: "oom" });
    expect(report.run.hint).toContain("8 MiB");
  });

  it("init() that throws on some lives fails the run, not just the load check", async () => {
    const report = await runChecks(input(BAD_BOTS.flakyInit));
    rejected(report);
    expect(report.load.status).toBe("pass");
    expect(report.run.fault).toMatchObject({ reason: "load", fault: "error" });
    expect(report.run.fault?.message).toContain("bad seed");
  });

  it(
    "a suicidal bot: runs clean but scores below easy, mostly wall deaths",
    async () => {
      const report = await runChecks(input(BAD_BOTS.suicidal), QUICK);
      const text = rejected(report);
      expect(report.run.status).toBe("pass");
      expect(report.qualify.status).toBe("fail");
      expect(report.qualify.score).toBeLessThan((report.qualify.bar as number) / 10);
      const wall = report.run.seeds.reduce((n, s) => n + (s.ends.wall ?? 0), 0);
      expect(wall).toBeGreaterThan(report.run.seeds.length * 2);
      expect(report.qualify.hint).toMatch(/deaths were into the wall/);
      expect(text).toContain("✗ Qualifies scores below easy");
    },
    FULL,
  );

  it(
    "a bot that only survives (circles, never eats) does not qualify",
    async () => {
      const report = await runChecks(input(BAD_BOTS.circler), QUICK);
      rejected(report);
      expect(report.run.status).toBe("pass");
      expect(report.qualify.status).toBe("fail");
    },
    FULL,
  );

  it.each([
    ["missingExport", "must 'export default", "export default defineBot"],
    ["noTick", "no tick() function", "needs a tick(state, mem, log)"],
    ["async", "async functions are not available", "Remove async/await"],
  ] as const)("%s: fails to load", async (name, error, hint) => {
    const report = await runChecks(input(BAD_BOTS[name]));
    rejected(report);
    expect(report.load.status).toBe("fail");
    expect(report.load.error).toContain(error);
    expect(report.load.hint).toContain(hint);
    expect([report.run.status, report.qualify.status]).toEqual(["skip", "skip"]);
  });

  it("an oversized bundle: rejected before it runs", async () => {
    const padding = `// ${"x".repeat(LIMITS.maxBundleBytes)}\n`;
    const report = await runChecks(input(botWithTick("return { turn: 0 };", padding)));
    const text = rejected(report);
    expect(report.limits.status).toBe("fail");
    expect(report.limits.problems).toEqual([
      {
        limit: "bundleBytes",
        actual: report.limits.details.bundleBytes,
        max: LIMITS.maxBundleBytes,
      },
    ]);
    expect([report.load.status, report.run.status, report.qualify.status]).toEqual([
      "skip",
      "skip",
      "skip",
    ]);
    expect(text).toContain("✗ Limits    over the upload limits: bundle is 256.1 KiB (max 256 KiB)");
  });

  it("too many source files: names the largest ones", async () => {
    const sources = Array.from({ length: 60 }, (_, i) => ({
      path: `src/f${i}.ts`,
      bytes: 100 + i,
    }));
    const report = await runChecks({ bundle: BAD_BOTS.circler, sources });
    rejected(report);
    expect(report.limits.summary).toBe("over the upload limits: 60 source files (max 50)");
    expect(report.limits.hint).toContain("src/f59.ts (159 B)");
  });
});

describe("formatReport", () => {
  it("tells the author what failed and what to do, with the last log lines", async () => {
    const report = await runChecks(
      input(
        botWithTick(
          "log('tick', state.lifeTick); if (state.lifeTick > 3) for (;;) {} return { turn: 0 };",
        ),
      ),
    );
    expect(formatReport(report)).toMatchInlineSnapshot(`
      "Checks failed: this bot would be rejected.

      ✓ Limits    1 source file, 131 B of source, bundle 131 B
      ✓ Loads     the bundle loads and default-exports a bot with tick()
      ✗ Runs      killed on seed 101 at tick 6 (life 1): 3 ticks in a row over budget
                  What to fix: tick() ran longer than its budget (10 ops, a few milliseconds) 3 ticks in a
                  row. Look for a loop that never ends, or work that grows with the game: nested loops
                  over every food × every segment, path searches without a limit. Keep the search small
                  (only the nearest things), cache results in mem and spread big jobs over several ticks.
      - Qualifies skipped: fix the problems above first

      Last log lines before it died (seed 101, tick 6):
          tick 0
          tick 1
          tick 2
          tick 3
          tick 4
          tick 5
          tick 6

      (5 seeds × 1000 ticks against easy, medium, hard and chaos; budget 10 ops per tick)
      "
    `);
  });
});
