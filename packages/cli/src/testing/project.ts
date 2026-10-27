import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { templateDir } from "../assets.ts";
import type { Io } from "../io.ts";

const made: string[] = [];

/** A throwaway folder with these files (paths relative to it). Removed by {@link cleanUp}. */
export function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "zerosnake-cli-"));
  made.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

export function cleanUp(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** An `Io` that keeps what a command prints. */
export function captureIo(cwd: string): Io & { stdout: () => string; stderr: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    cwd,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
  };
}

/** A small bot that eats, logs, and uses the SDK like an author's bot. */
export const GOOD_BOT = `import { defineBot, nearestFood, steerToward, CENTER } from "@zerosnake/sdk";
import { MARGIN } from "./tuning.ts";

export default defineBot({
  init() {
    return { ticks: 0 };
  },
  tick(state, mem, log) {
    mem.ticks++;
    if (mem.ticks % 50 === 0) log("tick", mem.ticks);
    if (state.wallDistance < MARGIN) return { turn: steerToward(state.self, CENTER) };
    const food = nearestFood(state);
    return { turn: food ? steerToward(state.self, food) : 0 };
  },
});
`;

export const TUNING = "export const MARGIN = 10;\n";

/** Burns its op budget every tick: dies by timeout after 3 strikes. */
export const SLOW_BOT = `import { defineBot } from "@zerosnake/sdk";
export default defineBot({
  tick(state, mem, log) {
    log("thinking hard");
    for (;;) {}
  },
});
`;

/** Throws every tick: dies by error after 3 in a row. */
export const THROWING_BOT = `import { defineBot } from "@zerosnake/sdk";
export default defineBot({
  tick(state) {
    return { turn: state.self.nope.x };
  },
});
`;

/**
 * The template's starter bot (`template/src/bot.ts`). Its seeds come from its bundle, so they
 * change with every edit to it or the SDK: tests that need a passing bot use {@link PASSING_BOT}.
 */
export const TEMPLATE_BOT = readFileSync(join(templateDir(), "src", "bot.ts"), "utf8");

/**
 * A bot that passes the deploy checks, for tests that need one: `src/testing/passing-bot.ts`.
 * Unlike {@link TEMPLATE_BOT}, its seeds never change. It imports only types from the SDK, so
 * its bundle (and the seeds that come from its hash) doesn't change when the SDK or the starter
 * bot does: it either passes every time or never. cli.test.ts checks that it stays that way.
 */
export const PASSING_BOT = readFileSync(join(import.meta.dirname, "passing-bot.ts"), "utf8");

/** Drives straight on into the wall every life: loads and runs, but can't qualify. */
export const SUICIDAL_BOT = `import { defineBot } from "@zerosnake/sdk";
export default defineBot({
  tick() {
    return { turn: 0 };
  },
});
`;
