/**
 * How much does room composition skew raw life scores, and does `normalizeScore` help?
 *
 *   pnpm --filter @zerosnake/rating sim
 *
 * Plays house-bot rooms of 12 snakes whose mix ranges from weak (chaos filler) to strong, keeps
 * every finished life, then prints the analysis in `analyze.ts` as Markdown. Env:
 *   MATCHES  matches per composition (default 12)   TICKS   ticks per match (default 20000)
 *   WORKERS  threads (default CPUs − 1)              SEED    base seed (default 1)
 *   SAVE     write the lives to this JSON file       LOAD    analyze a saved file instead
 */
import { readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { HouseBotName } from "@zerosnake/house-bots";
import { analyze, cellsOf } from "./analyze.ts";
import type { Composition, Life, MatchOptions } from "./room.ts";

/** 12 snakes each; one easy, medium and hard in every room so each kind is measured everywhere. */
const COMPOSITIONS: Record<string, Composition> = {
  chaos: { easy: 1, medium: 1, hard: 1, chaos: 9 },
  easy: { easy: 10, medium: 1, hard: 1 },
  balanced: { easy: 4, medium: 4, hard: 4 },
  medium: { easy: 1, medium: 10, hard: 1 },
  hard: { easy: 1, medium: 1, hard: 10 },
};
const KINDS: HouseBotName[] = ["easy", "medium", "hard"];

const env = process.env;
const MATCHES = Number(env.MATCHES ?? 12);
const TICKS = Number(env.TICKS ?? 20_000);
const WORKERS = Number(env.WORKERS ?? Math.max(1, availableParallelism() - 1));
const SEED = Number(env.SEED ?? 1);

const byComposition = env.LOAD ? load(env.LOAD) : await simulate();
if (env.SAVE) writeFileSync(env.SAVE, JSON.stringify(Object.fromEntries(byComposition)));

let state = SEED * 0x9e3779b9;
const rng = () => {
  // mulberry32
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const total = [...byComposition.values()].reduce((n, l) => n + l.length, 0);
console.log(`## Room composition skew\n`);
console.log(
  `${total} lives from ${env.LOAD ? "a saved run" : `${MATCHES} matches × ${TICKS} ticks per composition`}, 12 snakes per room.\n`,
);
console.log(analyze(COMPOSITIONS, cellsOf(byComposition), KINDS, rng).lines.join("\n"));

async function simulate(): Promise<Map<string, Life[]>> {
  const jobs: (MatchOptions & { id: number; name: string })[] = [];
  for (const [name, composition] of Object.entries(COMPOSITIONS)) {
    for (let m = 0; m < MATCHES; m++) {
      jobs.push({
        id: jobs.length,
        name,
        composition,
        seed: SEED * 100_000 + jobs.length,
        ticks: TICKS,
        warmup: 1000,
      });
    }
  }
  const result = new Map<string, Life[]>(Object.keys(COMPOSITIONS).map((n) => [n, []]));
  let next = 0;
  let done = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: Math.min(WORKERS, jobs.length) }, async () => {
      const worker = new Worker(new URL("./worker.ts", import.meta.url));
      for (let job = jobs[next++]; job; job = jobs[next++]) {
        const { name, ...options } = job;
        const lives = await new Promise<Life[]>((resolve, reject) => {
          worker.once("error", reject);
          worker.once("message", (m: { lives: Life[] }) => {
            worker.off("error", reject);
            resolve(m.lives);
          });
          worker.postMessage(options);
        });
        result.get(name)?.push(...lives);
        done++;
        const s = ((performance.now() - started) / 1000).toFixed(0);
        process.stderr.write(`\r${done}/${jobs.length} matches, ${s}s`);
      }
      await worker.terminate();
    }),
  );
  process.stderr.write("\n");
  return result;
}

function load(path: string): Map<string, Life[]> {
  return new Map(Object.entries(JSON.parse(readFileSync(path, "utf8")) as Record<string, Life[]>));
}
