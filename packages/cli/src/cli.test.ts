import { join } from "node:path";
import {
  CHECK_SEED_COUNT,
  CHECK_TICKS,
  type CheckReport,
  REPORT_VERSION,
  runChecks,
} from "@zerosnake/checks";
import { afterAll, describe, expect, it } from "vitest";
import { readSources } from "./artifact.ts";
import { bundleBot } from "./bundle.ts";
import { main } from "./cli.ts";
import { simCommand } from "./commands/sim.ts";
import { findProject } from "./project.ts";
import type { MatchUpdate } from "./sim/protocol.ts";
import {
  captureIo,
  cleanUp,
  GOOD_BOT,
  makeProject,
  SLOW_BOT,
  SUICIDAL_BOT,
  TEMPLATE_BOT,
  TUNING,
} from "./testing/project.ts";

afterAll(cleanUp);

function botProject(files: Record<string, string> = {}): string {
  return makeProject({
    "package.json": JSON.stringify({ name: "my-snake" }),
    "src/bot.ts": GOOD_BOT,
    "src/tuning.ts": TUNING,
    ...files,
  });
}

describe("zerosnake", () => {
  it("prints help", async () => {
    const io = captureIo(".");
    expect(await main(["--help"], io)).toBe(0);
    expect(io.stdout()).toContain("init <dir>");
    expect(await main([], io)).toBe(2);
  });

  it("rejects unknown commands and options with exit code 2", async () => {
    const io = captureIo(botProject());
    expect(await main(["nope"], io)).toBe(2);
    expect(io.stderr()).toContain('Unknown command "nope"');
    expect(await main(["sim", "--fast"], io)).toBe(2);
    expect(io.stderr()).toContain("zerosnake sim --help");
    expect(await main(["sim", "--ticks", "ten"], io)).toBe(2);
    expect(io.stderr()).toContain('--ticks must be a whole number ≥ 1, got "ten"');
  });

  it("has help for every command", async () => {
    for (const command of ["init", "sim", "test"]) {
      const io = captureIo(".");
      expect(await main([command, "--help"], io)).toBe(0);
      expect(io.stdout()).toContain(`Usage: zerosnake ${command}`);
    }
  });
});

describe("zerosnake sim --headless", () => {
  it("plays a match and prints standings and deaths", async () => {
    const io = captureIo(botProject());
    const code = await main(
      ["sim", "--headless", "--seed", "3", "--ticks", "300", "--vs", "easy,hard,hard"],
      io,
    );
    expect(io.stderr()).toBe("");
    expect(code).toBe(0);
    const out = io.stdout();
    expect(out).toContain("my-snake vs easy, hard, hard-2");
    expect(out).toContain("Match: seed 3, 300 ticks (30s of game time)");
    expect(out).toMatch(/my-snake \(you\)/);
    expect(out).toContain("my-snake: lives");
    expect(out).toContain("zerosnake sim --seed 3 --vs easy,hard,hard --ticks 300");
  });

  it("plays against another local bot by path", async () => {
    const dir = botProject({ "rivals/slow.ts": SLOW_BOT });
    const io = captureIo(dir);
    const code = await main(["sim", "--headless", "--ticks", "50", "--vs", "rivals/slow.ts"], io);
    expect(code).toBe(0);
    expect(io.stdout()).toMatch(/slow\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+ timeout/);
  });

  it("exits with 1 when the sandbox kills your bot", async () => {
    const io = captureIo(botProject({ "src/bot.ts": SLOW_BOT }));
    expect(await main(["sim", "--headless", "--ticks", "30", "--vs", "easy"], io)).toBe(1);
    expect(io.stdout()).toContain("too slow: 3 ticks in a row over budget");
    expect(io.stderr()).toContain("The sandbox killed your bot (2 lives)");
  });

  it("runs house bots natively on request", async () => {
    const io = captureIo(botProject());
    const args = ["sim", "--headless", "--ticks", "100", "--vs", "hard", "--seed", "1"];
    expect(await main([...args, "--native-house"], io)).toBe(0);
    expect(io.stdout()).toContain("hard ");
  });

  it("fails with exit code 1 and file:line when the bot doesn't build", async () => {
    const io = captureIo(botProject({ "src/tuning.ts": "export const MARGIN = ;\n" }));
    expect(await main(["sim", "--headless"], io)).toBe(1);
    expect(io.stderr()).toMatch(/src\/tuning\.ts:1:\d+/);
  });

  it("fails before the match when the bot can't load", async () => {
    const io = captureIo(
      botProject({ "src/bot.ts": 'throw new Error("missing config");\nexport default {};\n' }),
    );
    expect(await main(["sim", "--headless"], io)).toBe(1);
    expect(io.stderr()).toContain("my-snake failed to load: Error: missing config");
  });

  it("finds a bot folder without a package.json inside another project", async () => {
    const dir = makeProject({
      "package.json": JSON.stringify({ name: "outer" }),
      "inner/src/bot.ts": GOOD_BOT,
      "inner/src/tuning.ts": TUNING,
    });
    const io = captureIo(join(dir, "inner"));
    expect(await main(["sim", "--headless", "--ticks", "20", "--vs", "easy"], io)).toBe(0);
    expect(io.stdout()).toContain("inner vs easy");
  });

  it("explains a project without a bot", async () => {
    const io = captureIo(makeProject({ "package.json": "{}" }));
    expect(await main(["sim", "--headless"], io)).toBe(1);
    expect(io.stderr()).toContain("expected src/bot.ts");
    expect(io.stderr()).toContain("zerosnake init");
  });

  it("names an unknown opponent", async () => {
    const io = captureIo(botProject());
    expect(await main(["sim", "--headless", "--vs", "godlike"], io)).toBe(2);
    expect(io.stderr()).toContain('"godlike" is neither a house bot');
  });
});

describe("zerosnake sim (viewer)", () => {
  it("serves the match while it runs and stops on request", async () => {
    const io = captureIo(botProject());
    let seen: MatchUpdate | undefined;
    const waitForStop = async () => {
      const url = /Viewer: (\S+)/.exec(io.stdout())?.[1] as string;
      for (;;) {
        seen = (await (await fetch(`${url}api/match?from=0`)).json()) as MatchUpdate;
        if (seen.done) return;
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const code = await simCommand(
      ["--no-open", "--port", "0", "--seed", "5", "--ticks", "200", "--vs", "easy"],
      io,
      waitForStop,
    );
    expect(code).toBe(0);
    expect(seen?.bots).toEqual(["my-snake", "easy"]);
    expect(seen?.chunks).toHaveLength(2);
    expect(seen?.lives.some((l) => l.you)).toBe(true);
    expect(io.stdout()).toContain("The match is over");
  }, 30_000);
});

describe("zerosnake test", () => {
  it("passes the template bot with the server's checks and report", async () => {
    const io = captureIo(botProject({ "src/bot.ts": TEMPLATE_BOT }));
    expect(await main(["test"], io), io.stderr()).toBe(0);
    const out = io.stdout();
    expect(out).toContain("✓ bundles");
    expect(out).toContain("✓ within the deploy limits");
    expect(out).toContain("Checks passed: this bot can be deployed.");
    expect(out).toMatch(/✓ Runs {6}5 matches, 5000 ticks/);
    expect(out).toContain("✓ Qualifies beats easy");
    expect(out).toContain("Ready to deploy");
    // Not a TTY: one line instead of the live progress.
    expect(io.stderr()).toContain(
      "Running the checks (5 matches × 1000 ticks against the house bots)",
    );
  }, 120_000);

  it("prints the report as JSON with --json, and nothing else on stdout", async () => {
    const cwd = botProject({ "src/bot.ts": TEMPLATE_BOT });
    const io = captureIo(cwd);
    expect(await main(["test", "--json"], io)).toBe(0);
    const report = JSON.parse(io.stdout()) as CheckReport;
    expect(report).toMatchObject({ version: REPORT_VERSION, passed: true, ticks: CHECK_TICKS });
    expect(report.seeds).toHaveLength(CHECK_SEED_COUNT);
    expect(io.stderr()).toContain("✓ bundles");

    // The server's report: same bundle, same seeds, same verdict.
    const { root } = findProject(cwd);
    const bundle = await bundleBot(join(root, "src", "bot.ts"), { cwd: root });
    const sources = readSources(root, bundle).map(({ path, bytes }) => ({ path, bytes }));
    expect(report).toEqual(await runChecks({ bundle: bundle.code, sources }));
  }, 120_000);

  it("fails a bot that can't beat easy, and says so", async () => {
    const io = captureIo(botProject({ "src/bot.ts": SUICIDAL_BOT }));
    expect(await main(["test"], io)).toBe(1);
    const out = io.stdout();
    expect(out).toContain("Checks failed: this bot would be rejected.");
    expect(out).toContain("✓ Runs");
    expect(out).toContain("✗ Qualifies");
    expect(out).toContain("What to fix:");
    expect(out).not.toContain("Ready to deploy");
  }, 120_000);

  it("fails a bot that hangs, with its log", async () => {
    const io = captureIo(botProject({ "src/bot.ts": SLOW_BOT }));
    expect(await main(["test"], io)).toBe(1);
    const out = io.stdout();
    expect(out).toContain("✗ Runs");
    expect(out).toContain("over budget");
    expect(out).toContain("- Qualifies skipped");
    expect(out).toContain("thinking hard");
  }, 120_000);

  it("stops before the matches when the bundle is over a deploy limit", async () => {
    const io = captureIo(botProject({ "src/my notes.md": "# ideas" }));
    expect(await main(["test", "--json"], io)).toBe(1);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain("✗ source paths: src/my notes.md");
    expect(io.stderr()).not.toContain("Running the checks");
  });

  it("shows live progress on a terminal", async () => {
    const lines: string[] = [];
    const io = {
      ...captureIo(botProject({ "src/bot.ts": SLOW_BOT })),
      progress: (t: string) => lines.push(t),
    };
    expect(await main(["test"], io)).toBe(1);
    expect(lines[0]).toMatch(
      /^Running the checks \(5 matches × 1000 ticks against the house bots\)… 0% /,
    );
    expect(lines.at(-1)).toBe("");
    expect(io.stderr()).not.toContain("Running the checks");
  }, 120_000);
});
