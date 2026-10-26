import { beforeAll, describe, expect, it } from "vitest";
import { type CheckReport, checkSeeds, formatReport, LIMITS, runChecks } from "./index.ts";
import {
  BAD_BOTS,
  botWithTick,
  easyWith,
  houseBundle,
  input,
  longBody,
} from "./testing/fixtures.ts";

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
      expect(first.seeds).toEqual(await checkSeeds(medium, 5));
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
      expect(report.run.stats.firstError?.seed).toBe(101);
      expect((report.run.stats.firstError?.tick as number) % 97).toBe(13);
      expect(report.run.warnings.join("\n")).toMatch(/threw on \d+ tick\(s\).*Error: rare/);
    },
    FULL,
  );
});

function rejected(report: CheckReport): string {
  expect(report.passed).toBe(false);
  return formatReport(report);
}

describe("bad bots are rejected with a clear reason", () => {
  it("an infinite loop: timeout death", async () => {
    const report = await runChecks(input(BAD_BOTS.infiniteLoop));
    const text = rejected(report);
    expect(report.run.status).toBe("fail");
    expect(report.run.fault).toMatchObject({
      seed: report.seeds[0],
      life: 1,
      lifeTick: 23,
      atLoad: false,
      fault: "timeout",
      reason: "timeouts",
      message: "3 ticks in a row over budget",
    });
    // The fatal streak is the death, not a warning on top of it.
    expect(report.run.stats.timeoutTicks).toBe(0);
    expect(report.run.warnings).toEqual([]);
    expect(report.qualify.status).toBe("skip");
    expect(text).toContain(
      `✗ Runs      killed on seed ${report.seeds[0]} at tick ${report.run.fault?.tick} (life 1): 3 ticks in a row`,
    );
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
    const report = await runChecks(input(BAD_BOTS.flakyInit), QUICK);
    rejected(report);
    expect(report.load.status).toBe("pass");
    expect(report.run.fault).toMatchObject({ reason: "load", fault: "error", atLoad: true });
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
      ✗ Runs      killed on seed 443573865 at tick 1232152 (life 1): 3 ticks in a row over budget
                  What to fix: tick() ran longer than its budget (10 ops, a few milliseconds) 3 ticks in a
                  row. Look for a loop that never ends, or work that grows with the game: nested loops
                  over every food × every segment, path searches without a limit. Keep the search small
                  (only the nearest things), cache results in mem and spread big jobs over several ticks.
      - Qualifies skipped: fix the problems above first

      Last log lines before it died (seed 443573865, tick 1232152):
          tick 0
          tick 1
          tick 2
          tick 3
          tick 4
          tick 5
          tick 6

      (5 seeds × 1000 ticks against easy, medium, hard and chaos; budget 10 ops per tick, at most half of
      it on average)
      "
    `);
  });
});

describe("the check can't be told apart from the arena", () => {
  it("names, ticks and seeds look like a room's", async () => {
    // Throws (and so logs a warning) whenever it sees something only a check would show.
    const detector = await easyWith(`
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      if (!mem.info) mem.info = { tick: state.tick };
      if (!uuid.test(state.self.id)) throw new Error("tell: own id " + state.self.id);
      if (state.tick < 50000) throw new Error("tell: tick " + state.tick);
      for (const s of state.snakes) {
        const house = /^house-(easy|medium|hard|chaos)-\\d+-0$/.test(s.id) && s.author === "house:" + s.id.split("-")[1];
        const user = uuid.test(s.id) && uuid.test(s.author);
        if (!house && !user) throw new Error("tell: snake " + s.id + " by " + s.author);
      }`);
    const report = await runChecks(input(detector), QUICK);
    expect(report.run.warnings).toEqual([]);
    expect(report.run.stats.errorTicks).toBe(0);
    expect(report.run.status).toBe("pass");
  });

  it("seeds come from the bundle's hash: stable for one bundle, different for any edit", async () => {
    const bundle = BAD_BOTS.circler;
    const seeds = await checkSeeds(bundle, 5);
    expect(await checkSeeds(bundle, 5)).toEqual(seeds);
    expect(new Set(seeds).size).toBe(5);
    for (const s of seeds) expect(s >>> 0).toBe(s);
    expect(await checkSeeds(`${bundle} `, 5)).not.toEqual(seeds);
  });
});

describe("suite budget (until the sandbox meters real cost, #60)", () => {
  it("rejects a bot over the total op budget, deterministically", async () => {
    const heavy = await easyWith("let x = 0; for (let i = 0; i < 30000; i++) x += i * 0.5");
    const options = { ...QUICK, budget: { maxInterrupts: 500 } };
    const report = await runChecks(input(heavy), options);
    rejected(report);
    expect(report.run.status).toBe("fail");
    expect(report.run.overrun).toMatchObject({ limit: "maxInterrupts", max: 500, seed: 101 });
    expect(report.run.summary).toMatch(/^too slow: your ticks used more than 500 ops in total/);
    expect(report.qualify.status).toBe("skip");
    expect(JSON.stringify(await runChecks(input(heavy), options))).toBe(JSON.stringify(report));
  });

  it("the default caps leave honest bots far below them", async () => {
    const report = await runChecks(input(await houseBundle("hard")), QUICK);
    expect(report.run.status).toBe("pass");
    expect(report.run.cost.interrupts).toBeLessThan(report.budget.maxInterrupts / 10);
    expect(report.budget.maxInterrupts).toBe((3 * 400 * report.opBudget) / 2);
  });

  it("stops on the wall clock (Node), checked between ticks", async () => {
    let now = 0;
    const clock = () => (now += 10);
    const report = await runChecks(input(BAD_BOTS.circler), {
      ...QUICK,
      budget: { maxMillis: 2000 },
      clock,
    });
    rejected(report);
    expect(report.run.overrun).toMatchObject({ limit: "maxMillis", max: 2000, seed: 101 });
    expect(report.run.summary).toContain("too slow: the checks ran for over 2 s");
    expect(report.run.hint).toContain("each op is very slow");
  });

  it("catches a long straight-line loop body with the real clock", async () => {
    const t0 = performance.now();
    const report = await runChecks(input(await longBody(300, 20_000)), {
      ...QUICK,
      budget: { maxMillis: 1500 },
    });
    expect(report.run.overrun?.limit).toBe("maxMillis");
    expect(report.run.stats.peakInterrupts).toBeLessThanOrEqual(report.opBudget);
    // One tick of this bot can take a second or more, and the clock is read between ticks.
    expect(performance.now() - t0).toBeLessThan(30_000);
  }, 60_000);

  // Enable once #60 lands: the per-tick budget must then reject this bot by itself, with the
  // default settings, in seconds and the same way in Node and workerd (no wall clock involved).
  it.skip("rejects a long straight-line loop body by the per-tick budget (#60)", async () => {
    const t0 = performance.now();
    const report = await runChecks(input(await longBody(300, 20_000)));
    expect(report.run.fault?.reason).toBe("timeouts");
    expect(report.run.overrun).toBeNull();
    expect(performance.now() - t0).toBeLessThan(10_000);
  });
});
