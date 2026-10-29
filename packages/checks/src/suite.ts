import { houseBots } from "@zerosnake/house-bots";
import { createSandbox, DEFAULT_OP_BUDGET, type WasmModule, WORK_PER_OP } from "@zerosnake/sandbox";
import {
  AVERAGE_BUDGET_SHARE,
  CostMeter,
  DEFAULT_MAX_MILLIS,
  type Overrun,
  type SuiteBudget,
} from "./cost.ts";
import { checkSeeds } from "./disguise.ts";
import { faultHint, limitsHint, loadHint, overrunHint, qualifyHint, shortError } from "./hints.ts";
import { formatBytes, measureLimits, type SourceFile } from "./limits.ts";
import {
  emptyStats,
  type FaultDetails,
  type MatchOptions,
  type MatchResult,
  playMatch,
  playMatchPaused,
  type Seat,
  type TickStats,
} from "./match.ts";
import {
  type CheckReport,
  type LoadCheck,
  type QualifyCheck,
  REPORT_VERSION,
  type RunCheck,
  type SeedRun,
} from "./report.ts";

/** Matches per check: each on its own seed (SPEC §6). */
export const CHECK_SEED_COUNT = 5;
/** Ticks per seed after the candidate joins (100 s of game time at 10 ticks/s). */
export const CHECK_TICKS = 1000;

/** Peak budget use above this fraction is reported as a warning. */
const BUDGET_WARNING = 0.8;

export interface CheckInput {
  /** The bundled bot: one ESM file that default-exports `defineBot({ init, tick })`. */
  bundle: string;
  /** The uploaded source files with their sizes (only counted against the limits). */
  sources: readonly SourceFile[];
}

export interface CheckOptions {
  /**
   * The compiled QuickJS wasm, as for `createSandbox`. Required in Workers (a Queue consumer),
   * which can't compile wasm at runtime; loaded from disk in Node when omitted.
   */
  wasmModule?: WasmModule;
  /**
   * For tests only. Deploys are judged on {@link CHECK_SEED_COUNT} seeds from `checkSeeds(bundle)`
   * × {@link CHECK_TICKS} ticks and the default budget.
   */
  seeds?: readonly number[];
  ticks?: number;
  budget?: Partial<SuiteBudget>;
  /** Milliseconds, for {@link SuiteBudget.maxMillis}. Default `performance.now`. */
  clock?: () => number;
  /**
   * Awaited after each batch of every match (a few hundred ticks, a fraction of a second). The
   * checks consumer passes a timer, so a check doesn't hold its isolate's event loop for its
   * whole run (10–20 s of CPU with 20-snake rooms). Doesn't change the report.
   */
  pause?: () => Promise<void>;
}

/**
 * Runs the deploy checks of SPEC §6 on a bundle, in order, skipping the rest after a failure:
 *
 * 1. `limits`: ≤ 50 source files, ≤ 1 MiB of sources, bundle ≤ 256 KiB (`LIMITS`).
 * 2. `load`: the bundle loads in the sandbox and default-exports a bot with `tick()`.
 * 3. `run`: on each seed, a {@link CHECK_TICKS}-tick match against the house bots (easy, medium,
 *    hard, chaos), respawning on death. Isolated timeouts and exceptions are tolerated as in the
 *    arena (previous action, strike); a death by timeout, error or out of memory fails, and so
 *    does going over the suite's {@link SuiteBudget}.
 * 4. `qualify`: mean score per life ≥ that of `easy` playing the same seat on the same seeds.
 *
 * Used by `zerosnake test` (Node) and the version-check consumer (workerd); both get the same
 * report for the same input (except for the wall-clock cap, see {@link SuiteBudget}). Never
 * throws for problems in the bot.
 */
export async function runChecks(
  input: CheckInput,
  options: CheckOptions = {},
): Promise<CheckReport> {
  const seeds = options.seeds
    ? [...options.seeds]
    : await checkSeeds(input.bundle, CHECK_SEED_COUNT);
  const ticks = options.ticks ?? CHECK_TICKS;
  const opBudget = DEFAULT_OP_BUDGET;
  const budget = defaultBudget(seeds.length * ticks, opBudget, options.budget);
  const matchOptions = (seed: number) => ({ seed, ticks, opBudget });
  const { pause } = options;
  const play = async (seat: Seat, o: MatchOptions) =>
    pause ? playMatchPaused(seat, o, pause) : playMatch(seat, o);

  const report: CheckReport = {
    version: REPORT_VERSION,
    passed: false,
    seeds,
    ticks,
    opBudget,
    budget,
    limits: checkLimits(input),
    load: skippedLoad(),
    run: skippedRun(),
    qualify: skippedQualify(),
  };
  if (report.limits.status !== "pass") return report;

  // A fresh sandbox per call, so nothing carries over from an earlier run. The Sandbox has no
  // dispose(): every life is disposed by the match, and the wasm heap goes with the last
  // reference to `sandbox` when this function returns.
  const sandbox = await createSandbox(options.wasmModule ? { wasmModule: options.wasmModule } : {});
  const meter = new CostMeter(budget, options.clock ?? (() => performance.now()));
  const seat = { kind: "sandbox", sandbox, bundle: input.bundle, meter } as const;

  // The first life of the first match is the load check: same info as any arena life, so a bot
  // can't tell it apart.
  const matches: MatchResult[] = [];
  for (const seed of seeds) {
    const m = await play(seat, matchOptions(seed));
    if (matches.length === 0 && m.fault?.atLoad && m.fault.life === 1) {
      report.load = loadFailed(m.fault);
      return report;
    }
    matches.push(m);
    if (m.fault || m.overrun) break;
  }
  report.load = {
    status: "pass",
    summary: "the bundle loads and default-exports a bot with tick()",
    hint: null,
    error: null,
  };
  report.run = checkRun(matches, opBudget, meter);
  if (report.run.status !== "pass") return report;

  // The bar: `easy` playing the candidate's seat on the same seeds.
  const baseline: MatchResult[] = [];
  for (const seed of seeds) {
    baseline.push(await play({ kind: "house", bot: houseBots.easy }, matchOptions(seed)));
  }
  report.qualify = checkQualify(matches, baseline);
  report.passed = report.qualify.status === "pass";
  return report;
}

function defaultBudget(
  ticks: number,
  opBudget: number,
  overrides: Partial<SuiteBudget> = {},
): SuiteBudget {
  const ops = Math.floor(ticks * opBudget * AVERAGE_BUDGET_SHARE);
  return {
    maxMillis: DEFAULT_MAX_MILLIS,
    maxInterrupts: ops,
    maxWork: ops * WORK_PER_OP,
    ...overrides,
  };
}

function checkLimits({ bundle, sources }: CheckInput): CheckReport["limits"] {
  const { details, problems } = measureLimits(bundle, sources);
  const files = details.sourceFiles === 1 ? "1 source file" : `${details.sourceFiles} source files`;
  const sizes = `${files}, ${formatBytes(details.sourceBytes)} of source, bundle ${formatBytes(details.bundleBytes)}`;
  if (problems.length === 0) {
    return { status: "pass", summary: sizes, hint: null, details, problems };
  }
  // Exact bytes when rounding would make the size look like the limit.
  const size = (actual: number, max: number) =>
    formatBytes(actual) === formatBytes(max) ? `${actual} B` : formatBytes(actual);
  const over = problems.map((p) =>
    p.limit === "sourceFiles"
      ? `${p.actual} source files (max ${p.max})`
      : p.limit === "sourceBytes"
        ? `${size(p.actual, p.max)} of source (max ${formatBytes(p.max)})`
        : `bundle is ${size(p.actual, p.max)} (max ${formatBytes(p.max)})`,
  );
  return {
    status: "fail",
    summary: `over the upload limits: ${over.join(", ")}`,
    hint: limitsHint(problems, details),
    details,
    problems,
  };
}

function loadFailed(fault: FaultDetails): LoadCheck {
  return {
    status: "fail",
    summary: `the bundle does not load: ${shortError(fault.message)}`,
    hint: loadHint(fault),
    error: fault.message,
  };
}

function checkRun(matches: MatchResult[], opBudget: number, meter: CostMeter): RunCheck {
  const cost = { ...meter.cost };
  const stats = sumStats(matches.map((m) => m.stats));
  const seeds: SeedRun[] = matches.map((m) => {
    const ends: SeedRun["ends"] = {};
    for (const life of m.lives) ends[life.end] = (ends[life.end] ?? 0) + 1;
    return {
      seed: m.seed,
      ticks: m.ticks,
      lives: m.lives.length,
      score: round(m.lives.reduce((sum, l) => sum + l.score, 0)),
      ends,
    };
  });
  const fault = matches.find((m) => m.fault)?.fault ?? null;
  const overrun = matches.find((m) => m.overrun)?.overrun ?? null;
  const warnings: string[] = [];
  if (stats.timeoutTicks > 0) {
    warnings.push(
      `tick() went over its budget on ${stats.timeoutTicks} tick(s); each one replays your previous action, and 3 in a row kill the snake`,
    );
  }
  if (stats.errorTicks > 0 && stats.firstError) {
    const e = stats.firstError;
    warnings.push(
      `tick() threw on ${stats.errorTicks} tick(s), first on seed ${e.seed} at tick ${e.tick}: ${shortError(e.message)}; 3 in a row kill the snake`,
    );
  }
  const peak = Math.max(stats.peakInterrupts / opBudget, stats.peakWork / (opBudget * WORK_PER_OP));
  if (!fault && !overrun && peak > BUDGET_WARNING) {
    warnings.push(
      `your slowest tick used ${Math.round(peak * 100)}% of the budget; crowded rooms in the arena cost more than these matches`,
    );
  }
  if (fault) {
    return {
      status: "fail",
      summary: `killed on seed ${fault.seed} at tick ${fault.tick} (life ${fault.life}): ${shortError(fault.message)}`,
      hint: faultHint(fault, opBudget),
      fault,
      overrun: null,
      seeds,
      stats,
      cost,
      warnings,
    };
  }
  if (overrun) {
    return {
      status: "fail",
      summary: `too slow: ${overrunSummary(overrun)}, stopped on seed ${overrun.seed} at tick ${overrun.tick}`,
      hint: overrunHint(overrun),
      fault: null,
      overrun,
      seeds,
      stats,
      cost,
      warnings,
    };
  }
  const lives = seeds.reduce((n, s) => n + s.lives, 0);
  const total = seeds.reduce((n, s) => n + s.ticks, 0);
  return {
    status: "pass",
    summary: `${matches.length} matches, ${total} ticks, ${lives} lives without a timeout, error or out-of-memory death`,
    hint: null,
    fault: null,
    overrun: null,
    seeds,
    stats,
    cost,
    warnings,
  };
}

function overrunSummary(o: Overrun): string {
  switch (o.limit) {
    case "maxMillis":
      return `the checks ran for over ${o.max / 1000} s`;
    case "maxInterrupts":
      return `your ticks used more than ${o.max} ops in total (on average over half the budget)`;
    case "maxWork":
      return `built-in functions did more than ${o.max} units of work in total (on average over half the budget)`;
  }
}

function checkQualify(matches: MatchResult[], baseline: MatchResult[]): QualifyCheck {
  const bar = meanLifeScore(baseline);
  const barLives = countLives(baseline);
  const score = meanLifeScore(matches);
  const lives = countLives(matches);
  const perSeed = matches.map((m, i) => ({
    seed: m.seed,
    score: meanLifeScore([m]),
    bar: meanLifeScore([baseline[i] as MatchResult]),
  }));
  const passed = score >= bar;
  const versus = `mean score per life ${score} vs easy's ${bar} (${lives} lives vs ${barLives})`;
  return {
    status: passed ? "pass" : "fail",
    summary: passed ? `beats easy: ${versus}` : `scores below easy: ${versus}`,
    hint: passed ? null : qualifyHint(matches.flatMap((m) => m.lives)),
    metric: "meanLifeScore",
    score,
    bar,
    lives,
    barLives,
    perSeed,
  };
}

/** Pooled over all matches: total score / total lives, rounded to 3 decimals. */
function meanLifeScore(matches: readonly MatchResult[]): number {
  const lives = countLives(matches);
  const total = matches.reduce((sum, m) => sum + m.lives.reduce((s, l) => s + l.score, 0), 0);
  return lives === 0 ? 0 : round(total / lives);
}

function countLives(matches: readonly MatchResult[]): number {
  return matches.reduce((n, m) => n + m.lives.length, 0);
}

function sumStats(all: TickStats[]): TickStats {
  const out = emptyStats();
  for (const s of all) {
    out.ticks += s.ticks;
    out.timeoutTicks += s.timeoutTicks;
    out.errorTicks += s.errorTicks;
    out.firstError ??= s.firstError;
    out.peakInterrupts = Math.max(out.peakInterrupts, s.peakInterrupts);
    out.peakWork = Math.max(out.peakWork, s.peakWork);
  }
  return out;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

const SKIPPED = "skipped: fix the problems above first";

function skippedLoad(): LoadCheck {
  return { status: "skip", summary: SKIPPED, hint: null, error: null };
}

function skippedRun(): RunCheck {
  return {
    status: "skip",
    summary: SKIPPED,
    hint: null,
    fault: null,
    overrun: null,
    seeds: [],
    stats: emptyStats(),
    cost: { interrupts: 0, work: 0 },
    warnings: [],
  };
}

function skippedQualify(): QualifyCheck {
  return {
    status: "skip",
    summary: SKIPPED,
    hint: null,
    metric: "meanLifeScore",
    score: null,
    bar: null,
    lives: null,
    barLives: null,
    perSeed: [],
  };
}
