/**
 * Long house-bot ordering run (the CI test is a small slice of this):
 *
 *   pnpm --filter @zerosnake/house-bots bench [matches=100] [ticks=1500] [lineup=easy,medium,...] [turnRate]
 *
 * Prints per-slot and per-life score, deaths per slot and how often each pair is ordered.
 */
import { type HouseBotName, RANKED } from "../src/index.ts";
import { runMatch, type SlotResult, summarize } from "../src/match.ts";

// The package's lib is plain ES (bots run in the sandbox), so declare the two Node globals used.
declare const process: { argv: string[] };
declare const console: { log(message: string): void };

const [matchesArg, ticksArg, lineupArg, turnRateArg] = process.argv.slice(2);
const matches = Number(matchesArg ?? 100);
const ticks = Number(ticksArg ?? 1500);
const lineup = lineupArg
  ? (lineupArg.split(",").map((s) => s.trim()) as HouseBotName[])
  : [...RANKED, ...RANKED, ...RANKED, ...RANKED];
const bots = [...new Set(lineup)];

const results: SlotResult[][] = [];
const pairWins = new Map<string, number>();
const started = Date.now();
for (let m = 0; m < matches; m++) {
  const config = turnRateArg ? { turnRate: Number(turnRateArg) } : undefined;
  const match = runMatch({ seed: 1000 + m, lineup, ticks, ...(config && { config }) });
  results.push(match);
  const byBot = summarize([match]);
  for (const a of bots) {
    for (const b of bots) {
      if (a === b || (byBot[a]?.perSlot ?? 0) >= (byBot[b]?.perSlot ?? 0)) continue;
      const key = `${a}<${b}`;
      pairWins.set(key, (pairWins.get(key) ?? 0) + 1);
    }
  }
}
const seconds = (Date.now() - started) / 1000;

console.log(
  `${matches} matches × ${ticks} ticks, lineup ${lineup.join(",")} (${seconds.toFixed(1)} s)`,
);
const summary = summarize(results);
for (const bot of bots) {
  const s = summary[bot];
  if (!s) continue;
  console.log(
    `${bot.padEnd(7)} per slot ${s.perSlot.toFixed(0).padStart(6)}  per life ${s.perLife.toFixed(0).padStart(6)}  deaths/slot ${s.deathsPerSlot.toFixed(2)} (wall ${s.wallDeathsPerSlot.toFixed(2)})`,
  );
}
for (const [pair, n] of [...pairWins].sort()) console.log(`${pair}: ${n}/${matches} matches`);
