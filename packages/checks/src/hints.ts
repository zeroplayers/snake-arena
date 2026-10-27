// What to tell the author when a check fails. Plain language: the reader may not know what an
// interrupt or a QuickJS context is, only what their bot does.
import type { Death } from "@zerosnake/sandbox";
import type { Overrun } from "./cost.ts";
import { formatBytes, type LimitProblem, type LimitsDetails } from "./limits.ts";
import type { FaultDetails, LifeResult } from "./match.ts";

/**
 * The first line of a sandbox error, plus where in the bundle it was thrown: `Error: boom (at
 * bot.js:2:78)`. The full message, stack included, stays in the JSON.
 */
export function shortError(message: string): string {
  const [first = "", ...rest] = message.split("\n");
  const frame = rest.map((l) => /\((bot\.js:\d+:\d+)\)/.exec(l)?.[1]).find(Boolean);
  return frame ? `${first.trim()} (at ${frame})` : first.trim();
}

export function limitsHint(problems: LimitProblem[], details: LimitsDetails): string {
  const parts: string[] = [];
  for (const p of problems) {
    if (p.limit === "bundleBytes") {
      parts.push(
        "The bundle is everything your bot imports, inlined. Drop big dependencies and data tables (compute them in init() instead), and don't inline assets.",
      );
    } else if (p.limit === "sourceFiles") {
      parts.push("Only src/ is uploaded: merge small files or move non-code files out of src/.");
    } else {
      parts.push("Move data files, fixtures and generated code out of src/.");
    }
  }
  if (details.largest.length > 0) {
    const list = details.largest.map((f) => `${f.path} (${formatBytes(f.bytes)})`).join(", ");
    parts.push(`Largest source files: ${list}.`);
  }
  return parts.join(" ");
}

export function loadHint(death: Pick<Death, "fault" | "reason" | "message">): string {
  const m = death.message;
  if (m.includes("export default")) {
    return "Your entry file must end with `export default defineBot({ tick(state, mem, log) { ... } })` (import defineBot from @zerosnake/sdk). A named export like `export const bot` is not enough.";
  }
  if (m.includes("no tick()")) {
    return "The default export needs a tick(state, mem, log) function that returns { turn, boost? }.";
  }
  if (m.includes("async")) {
    return "Remove async/await and promises: tick() and init() must return their result directly.";
  }
  if (m.includes("BigInt")) return "Use plain numbers instead of BigInt (no `123n` literals).";
  if (m.includes("import")) {
    return "Bundle your code into one file: the sandbox has no import(), require() or module loader.";
  }
  if (death.fault === "timeout") {
    return "Loading the module and running init() took too long. Move heavy precomputation out of the top level and init(), or make it lazy.";
  }
  if (death.reason === "oom") {
    return "Loading the module used more than the 8 MiB memory limit: shrink precomputed tables.";
  }
  return "The bundle threw while loading or in init(). Run it with `zerosnake sim` to see the stack, and check for code that needs Node, the browser, Date, fetch or timers: none of them exist in the sandbox.";
}

export function faultHint(f: FaultDetails, opBudget: number): string {
  switch (f.reason) {
    case "timeouts":
      return `tick() ran longer than its budget (${opBudget} ops, a few milliseconds) 3 ticks in a row. Look for a loop that never ends, or work that grows with the game: nested loops over every food × every segment, path searches without a limit. Keep the search small (only the nearest things), cache results in mem and spread big jobs over several ticks.`;
    case "errors":
      return "tick() threw 3 ticks in a row. Remember that other snakes' head and angle are null when the head is out of sight, food and snakes can be empty, and segments only lists the visible part of a body. Wrap risky code in try/catch and fall back to a safe action.";
    case "oom":
      return "Your bot used more than its 8 MiB of memory. Something in mem (or at module level) grows every tick: cap histories, clear maps you no longer need, and don't keep whole states.";
    case "load":
      return `A new life failed to start: ${f.message}. init() must work for every spawn, whatever info.seed and info.snakeId are.`;
    case "crash":
      return "The sandbox crashed while running your bot. This is likely a bug on our side: please report it with the bundle.";
  }
}

/** Says what most likely costs the bot its score, from how its lives went. */
export function qualifyHint(lives: LifeResult[]): string {
  const count = (end: string) => lives.filter((l) => l.end === end).length;
  const wall = count("wall");
  const collision = count("collision");
  const deaths = lives.length - count("window");
  const tips: string[] = [];
  if (deaths > 0 && wall >= collision && wall > 0) {
    tips.push(
      `${wall} of your ${deaths} deaths were into the wall: turn back earlier (state.wallDistance) and remember you can only turn by self.turnRate per tick.`,
    );
  } else if (collision > 0) {
    tips.push(
      `${collision} of your ${deaths} deaths were collisions with other snakes: steer away from bodies near your head, and avoid head-on meetings with bigger snakes.`,
    );
  }
  if (deaths <= lives.length / 2) {
    tips.push(
      "Your score comes from your length over time (plus kills): eat more food, and don't boost unless it pays off, since boosting burns length.",
    );
  } else {
    tips.push("A life's score is its length over time, so staying alive matters most.");
  }
  return tips.join(" ");
}

export function overrunHint(o: Overrun): string {
  if (o.limit === "maxMillis") {
    return "Your bot stays inside its op count but each op is very slow: long loop bodies, big blocks of straight-line code or huge expressions run between two budget checks. Do much less work per tick: precompute in init(), cache in mem, and look only at nearby food and snakes.";
  }
  return "On average your ticks use more than half of their budget. That leaves no room for crowded rooms, where every tick costs more. Do less work per tick: cache results in mem, look only at nearby food and snakes, and spread big searches over several ticks.";
}
