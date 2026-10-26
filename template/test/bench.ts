/**
 * Plays your bot (or several versions of it) in the same local matches against house bots and
 * prints a score table. Until `zerosnake sim` exists, this is how to compare versions:
 *
 *   npm run bench                                  # src/bot.ts
 *   npm run bench -- src/bot.ts .zerosnake/prev/src/bot.ts
 *   npm run bench -- --seeds 40 --ticks 3000 src/bot.ts
 *   npm run bench -- --deaths 3                    # also print the last ticks before 3 deaths
 *
 * Every bot plays the same seeds against the same lineup, so differences come from the bots.
 * Scores are per life (the arena rates a version by its mean life score); lives still going when
 * a match ends count with their score so far. `±` is the standard error of the mean: treat two
 * versions as different only when their means are further apart than about twice that.
 */
import { parseArgs } from "node:util";
import type { HouseBotName } from "@zerosnake/house-bots";
import { nearestDanger } from "@zerosnake/sdk";
import { BUDGET, bundleBot, type Life, playMatch } from "./match.ts";

const LINEUP: HouseBotName[] = ["easy", "easy", "medium", "hard", "chaos"];

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    seeds: { type: "string", default: "20" },
    ticks: { type: "string", default: "3000" },
    deaths: { type: "string", default: "0" },
    context: { type: "string", default: "8" },
  },
});
const seeds = Number(values.seeds);
const ticks = Number(values.ticks);
const entries = positionals.length > 0 ? positionals : ["src/bot.ts"];
const deathsToShow = Number(values.deaths);
const contextTicks = Number(values.context);

console.log(`${seeds} seeds x ${ticks} ticks vs ${LINEUP.join(", ")}`);
const rows: string[][] = [["bot", "lives", "mean score", "mean ticks", "deaths", "max ops"]];
const house: Life[] = [];
for (const entry of entries) {
  const bundle = await bundleBot(entry);
  const lives: Life[] = [];
  const problems: string[] = [];
  let maxOps = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const r = await playMatch(bundle, { seed, ticks, opponents: LINEUP });
    lives.push(...r.lives);
    problems.push(...r.problems);
    maxOps = Math.max(maxOps, r.maxInterrupts);
    if (entry === entries[0]) house.push(...r.houseLives);
  }
  rows.push(summary(entry, lives, `${maxOps}/${BUDGET.interrupts}`));
  for (const life of lives.filter((l) => l.cause !== "alive").slice(0, deathsToShow)) {
    printDeath(entry, life);
  }
  for (const p of problems.slice(0, 5)) console.log(`${entry}: ${p}`);
  if (problems.length > 5) console.log(`${entry}: ...and ${problems.length - 5} more problems`);
}
for (const name of new Set(LINEUP)) {
  rows.push(
    summary(
      `house:${name}`,
      house.filter((l) => l.bot === name),
      "-",
    ),
  );
}

console.log("");
const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => r[i]?.length ?? 0))) ?? [];
for (const row of rows) {
  console.log(
    row
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd(),
  );
}

/** The last ticks before a death: what the bot saw (summarised), what it did, what it logged. */
function printDeath(entry: string, life: Life) {
  const by = life.killer ? ` into ${life.killer}` : "";
  const why = life.error ? ` (${life.error})` : "";
  console.log(
    `\n${entry}: seed ${life.seed}, tick ${life.tick}: ${life.cause}${by}${why} after ${life.lifeTicks} ticks, score ${life.score.toFixed(1)}`,
  );
  for (const t of life.trace.slice(-contextTicks)) {
    const { self, wallDistance, snakes, food } = t.state;
    const danger = nearestDanger(t.state);
    const near = danger ? `${danger.snake.id} gap ${danger.gap.toFixed(1)}` : "none";
    const act = `turn ${t.action.turn.toFixed(2)}${t.action.boost ? " boost" : ""}`;
    console.log(
      `  [${t.tick}] head (${self.head.x.toFixed(1)}, ${self.head.y.toFixed(1)}) angle ${self.angle.toFixed(2)} length ${self.length.toFixed(1)} wall ${wallDistance.toFixed(1)} | ${snakes.length} snakes, nearest body ${near} | ${food.length} food | ${act} | ${t.outcome}, ${t.interrupts} ops`,
    );
    for (const line of t.log) console.log(`      log: ${line}`);
    if (t.error) console.log(`      error: ${t.error}`);
  }
}

function summary(name: string, lives: Life[], ops: string): string[] {
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const stderr = (xs: number[]) => {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    const variance = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
    return Math.sqrt(variance / xs.length);
  };
  const scores = lives.map((l) => l.score);
  const causes = new Map<string, number>();
  for (const l of lives) causes.set(l.cause, (causes.get(l.cause) ?? 0) + 1);
  return [
    name,
    String(lives.length),
    `${mean(scores).toFixed(1)} ± ${stderr(scores).toFixed(1)}`,
    mean(lives.map((l) => l.lifeTicks)).toFixed(0),
    [...causes].map(([c, n]) => `${c} ${n}`).join(", "),
    ops,
  ];
}
