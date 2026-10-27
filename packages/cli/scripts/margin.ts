/**
 * How much a bot's qualification depends on the luck of its seeds. `zerosnake test` and the
 * server judge a bundle on the 5 seeds its hash gives, so every edit plays other seeds. This runs
 * the same checks on many seed sets, as many different bundles would get them, and prints the
 * distribution of the margin: mean score per life / easy's in the same seat. For whoever changes
 * the starter bot (`template/MAINTAINING.md`); authors have `zerosnake test`.
 *
 *   pnpm --filter zerosnake margin [entry] [--sets 200] [--from 0] [--jobs 4] [--minify]
 *
 * `entry` defaults to the template's `src/bot.ts`. Seed set `n` is `checkSeeds("seed set n")`.
 * The script runs with `--experimental-transform-types` because `@zerosnake/checks` uses
 * TypeScript parameter properties. About 2 s of CPU per seed set.
 */
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { CHECK_SEED_COUNT, checkSeeds, runChecks } from "@zerosnake/checks";
import { WORK_PER_OP } from "@zerosnake/sandbox";
import { transform } from "esbuild";
import { templateDir } from "../src/assets.ts";
import { bundleBot } from "../src/bundle.ts";
import { findProject } from "../src/project.ts";

interface SetResult {
  set: number;
  passed: boolean;
  score: number;
  bar: number;
  lives: number;
  /** Peak per-tick cost, as a share of the per-tick budget. */
  peak: number;
  /** Cost over the suite, as a share of what the suite allows on average. */
  average: number;
}

async function measure(bundle: string, sets: number[]): Promise<SetResult[]> {
  const out: SetResult[] = [];
  for (const set of sets) {
    const seeds = await checkSeeds(`seed set ${set}`, CHECK_SEED_COUNT);
    const r = await runChecks({ bundle, sources: [] }, { seeds, budget: { maxMillis: 600_000 } });
    const { run, qualify } = r;
    out.push({
      set,
      passed: r.passed,
      score: qualify.score ?? 0,
      bar: qualify.bar ?? 0,
      lives: qualify.lives ?? 0,
      peak: Math.max(
        run.stats.peakInterrupts / r.opBudget,
        run.stats.peakWork / (r.opBudget * WORK_PER_OP),
      ),
      average: Math.max(
        run.cost.interrupts / r.budget.maxInterrupts,
        run.cost.work / r.budget.maxWork,
      ),
    });
  }
  return out;
}

if (!isMainThread) {
  const { bundle, sets } = workerData as { bundle: string; sets: number[] };
  parentPort?.postMessage(await measure(bundle, sets));
} else {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      sets: { type: "string", default: "200" },
      from: { type: "string", default: "0" },
      minify: { type: "boolean", default: false },
      jobs: {
        type: "string",
        default: String(Math.max(1, Math.min(8, availableParallelism() - 1))),
      },
    },
  });
  const entry = resolve(positionals[0] ?? join(templateDir(), "src", "bot.ts"));
  const bundled = await bundleBot(entry, { cwd: findProject(dirname(entry)).root });
  // Authors may minify: the sandbox's metering must cost the same either way.
  const code = values.minify
    ? (await transform(bundled.code, { minify: true, format: "esm", target: "es2023" })).code
    : bundled.code;
  const bytes = Buffer.byteLength(code);
  const all = Array.from({ length: Number(values.sets) }, (_, i) => Number(values.from) + i);
  const jobs = Math.min(Number(values.jobs), all.length);
  console.log(
    `${entry} (${bytes} bytes): ${all.length} seed sets × ${CHECK_SEED_COUNT} seeds, ${jobs} jobs`,
  );

  const parts = await Promise.all(
    Array.from({ length: jobs }, (_, j) => {
      const sets = all.filter((_, i) => i % jobs === j);
      return new Promise<SetResult[]>((resolve, reject) => {
        new Worker(new URL(import.meta.url), { workerData: { bundle: code, sets } })
          .once("message", resolve)
          .once("error", reject);
      });
    }),
  );
  // A set that failed before qualifying (a fault, too slow) counts as 0×.
  const ratio = (r: SetResult) => (r.bar > 0 ? r.score / r.bar : 0);
  const results = parts.flat().sort((a, b) => ratio(a) - ratio(b));
  const at = (q: number) =>
    ratio(results[Math.min(results.length - 1, Math.floor(q * results.length))] as SetResult);
  const count = (f: (r: SetResult) => boolean) => results.filter(f).length;
  const fmt = (x: number) => `${x.toFixed(2)}×`;
  console.log(
    `margin (mean score per life / easy's): min ${fmt(at(0))}, 1% ${fmt(at(0.01))}, 5% ${fmt(at(0.05))}, ` +
      `median ${fmt(at(0.5))}, max ${fmt(at(1))}`,
  );
  console.log(
    `failed ${count((r) => !r.passed)}, below 1.5× ${count((r) => ratio(r) < 1.5)}, below 2× ${count((r) => ratio(r) < 2)}`,
  );
  const mean = (f: (r: SetResult) => number) =>
    results.reduce((s, r) => s + f(r), 0) / results.length;
  console.log(
    `mean score per life ${mean((r) => r.score).toFixed(1)} vs easy ${mean((r) => r.bar).toFixed(1)}, ` +
      `${(mean((r) => r.lives) / CHECK_SEED_COUNT).toFixed(2)} lives per match`,
  );
  console.log(
    `budget: peak tick ${fmt(Math.max(...results.map((r) => r.peak)))} of the per-tick budget, ` +
      `suite ${fmt(Math.max(...results.map((r) => r.average)))} of the average allowed`,
  );
  console.log(
    `worst: ${results
      .slice(0, 3)
      .map((r) => `set ${r.set} ${r.score.toFixed(1)} vs ${r.bar.toFixed(1)}`)
      .join("; ")}`,
  );
}
