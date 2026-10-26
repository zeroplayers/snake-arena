import { afterAll, describe, expect, it } from "vitest";
import { main } from "./cli.ts";
import { simCommand } from "./commands/sim.ts";
import type { MatchUpdate } from "./sim/protocol.ts";
import { captureIo, cleanUp, GOOD_BOT, makeProject, SLOW_BOT, TUNING } from "./testing/project.ts";

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
  it("bundles and loads the bot, then says the check suite is pending", async () => {
    const io = captureIo(botProject());
    expect(await main(["test"], io)).toBe(1);
    expect(io.stdout()).toContain("bundles");
    expect(io.stdout()).toContain("loads in the sandbox");
    expect(io.stderr()).toContain("coming with zeroplayers/snake-arena#13");
  });
});
