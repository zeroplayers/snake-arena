import { DEFAULT_CONFIG } from "@zerosnake/engine";
import { houseBots } from "@zerosnake/house-bots";
import {
  createSandbox,
  DEFAULT_OP_BUDGET,
  type Sandbox,
  type WasmModule,
  WORK_PER_OP,
} from "@zerosnake/sandbox";
import { LOG_LIMIT_BYTES } from "@zerosnake/sdk";
import { faultHint, limitsHint, loadHint, qualifyHint, shortError } from "./hints.ts";
import { formatBytes, measureLimits, type SourceFile } from "./limits.ts";
import { CANDIDATE_ID, type MatchResult, playMatch, type TickStats } from "./match.ts";
import {
  type CheckReport,
  type LoadCheck,
  type QualifyCheck,
  REPORT_VERSION,
  type RunCheck,
  type SeedRun,
} from "./report.ts";

/** The fixed seeds every deploy is checked on. Changing them changes every report. */
export const CHECK_SEEDS: readonly number[] = [101, 202, 303, 404, 505];
/** Ticks per seed (100 s of game time at 10 ticks/s). */
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
  /** For tests only: deploys are always judged on {@link CHECK_SEEDS} × {@link CHECK_TICKS}. */
  seeds?: readonly number[];
  ticks?: number;
}

/**
 * Runs the deploy checks of SPEC §6 on a bundle, in order, skipping the rest after a failure:
 *
 * 1. `limits`: ≤ 50 source files, ≤ 1 MiB of sources, bundle ≤ 256 KiB (`LIMITS`).
 * 2. `load`: the bundle loads in the sandbox and default-exports a bot with `tick()`.
 * 3. `run`: on each seed, a {@link CHECK_TICKS}-tick match against the house bots (easy, medium,
 *    hard, chaos), respawning on death. Isolated timeouts and exceptions are tolerated as in the
 *    arena (previous action, strike); a death by timeout, error or out of memory fails.
 * 4. `qualify`: mean score per life ≥ that of `easy` playing the same seat on the same seeds.
 *
 * Used by `zerosnake test` (Node) and the version-check consumer (workerd); both get the same
 * report for the same input. A fresh sandbox is created per call, so nothing carries over from
 * an earlier run. Never throws for problems in the bot.
 */
export async function runChecks(
  input: CheckInput,
  options: CheckOptions = {},
): Promise<CheckReport> {
  const seeds = [...(options.seeds ?? CHECK_SEEDS)];
  const ticks = options.ticks ?? CHECK_TICKS;
  const opBudget = DEFAULT_OP_BUDGET;
  const matchOptions = (seed: number) => ({ seed, ticks, opBudget });

  const report: CheckReport = {
    version: REPORT_VERSION,
    passed: false,
    seeds,
    ticks,
    opBudget,
    limits: checkLimits(input),
    load: skippedLoad(),
    run: skippedRun(),
    qualify: skippedQualify(),
  };
  if (report.limits.status !== "pass") return report;

  const sandbox = await createSandbox(options.wasmModule ? { wasmModule: options.wasmModule } : {});
  report.load = checkLoad(sandbox, input.bundle, opBudget);
  if (report.load.status !== "pass") return report;

  const matches: MatchResult[] = [];
  for (const seed of seeds) {
    const m = playMatch({ kind: "sandbox", sandbox, bundle: input.bundle }, matchOptions(seed));
    matches.push(m);
    if (m.fault) break;
  }
  report.run = checkRun(matches, opBudget);
  if (report.run.status !== "pass") return report;

  report.qualify = checkQualify(matches, baselineFor(seeds, ticks, opBudget));
  report.passed = report.qualify.status === "pass";
  return report;
}

/** Baseline matches by seeds and ticks. They are deterministic, so one run per isolate is enough. */
const baselines = new Map<string, MatchResult[]>();

/** `easy` playing the candidate's seat on the same seeds: the qualification bar. */
function baselineFor(seeds: number[], ticks: number, opBudget: number): MatchResult[] {
  const key = `${ticks}/${opBudget}/${seeds.join(",")}`;
  let matches = baselines.get(key);
  if (!matches) {
    matches = seeds.map((seed) =>
      playMatch({ kind: "house", bot: houseBots.easy }, { seed, ticks, opBudget }),
    );
    baselines.set(key, matches);
  }
  return matches;
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

function checkLoad(sandbox: Sandbox, bundle: string, opBudget: number): LoadCheck {
  const life = sandbox.startLife(bundle, {
    snakeId: CANDIDATE_ID,
    worldRadius: DEFAULT_CONFIG.arenaRadius,
    visionRadius: DEFAULT_CONFIG.visionRadius,
    tickRate: 10,
    maxLifeTicks: DEFAULT_CONFIG.lifeCap,
    opBudget,
    logLimitBytes: LOG_LIMIT_BYTES,
    seed: 0,
  });
  const death = life.death;
  life.dispose();
  if (!death) {
    return {
      status: "pass",
      summary: "the bundle loads and default-exports a bot with tick()",
      hint: null,
      error: null,
    };
  }
  return {
    status: "fail",
    summary: `the bundle does not load: ${shortError(death.message)}`,
    hint: loadHint(death),
    error: death.message,
  };
}

function checkRun(matches: MatchResult[], opBudget: number): RunCheck {
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
  if (!fault && peak > BUDGET_WARNING) {
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
      seeds,
      stats,
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
    seeds,
    stats,
    warnings,
  };
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
  const out: TickStats = {
    ticks: 0,
    timeoutTicks: 0,
    errorTicks: 0,
    firstError: null,
    peakInterrupts: 0,
    peakWork: 0,
  };
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
    seeds: [],
    stats: sumStats([]),
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
