import type { LimitProblem, LimitsDetails } from "./limits.ts";
import type { FaultDetails, LifeEnd, TickStats } from "./match.ts";

/** Bump when the JSON shape changes incompatibly; stored with each version's report. */
export const REPORT_VERSION = 1;

export type CheckId = "limits" | "load" | "run" | "qualify";
export type CheckStatus = "pass" | "fail" | "skip";

/**
 * The machine-readable result of {@link runChecks}. Plain JSON, and a pure function of the bundle,
 * the sources' sizes and the options: no timings, no randomness, so the same upload always gets
 * the same report, in the CLI and on the server.
 */
export interface CheckReport {
  version: typeof REPORT_VERSION;
  passed: boolean;
  /** Seeds and ticks per seed the run and qualification used. */
  seeds: number[];
  ticks: number;
  opBudget: number;
  limits: LimitsCheck;
  load: LoadCheck;
  run: RunCheck;
  qualify: QualifyCheck;
}

interface CheckBase {
  status: CheckStatus;
  /** One line a person can read: what passed, or what is wrong. */
  summary: string;
  /** What to change, when the check failed. */
  hint: string | null;
}

export interface LimitsCheck extends CheckBase {
  details: LimitsDetails;
  problems: LimitProblem[];
}

export interface LoadCheck extends CheckBase {
  /** The sandbox's message when the bundle fails to load. */
  error: string | null;
}

export interface SeedRun {
  seed: number;
  /** Ticks simulated before the end (or the fault). */
  ticks: number;
  lives: number;
  score: number;
  /** How the candidate's lives ended, by cause (`window`: alive at the end of the match). */
  ends: Partial<Record<LifeEnd, number>>;
}

export interface RunCheck extends CheckBase {
  /** The fatal sandbox death, if any. */
  fault: FaultDetails | null;
  seeds: SeedRun[];
  stats: TickStats;
  /** Problems that didn't fail the check but will cost lives in the arena. */
  warnings: string[];
}

export interface SeedScore {
  seed: number;
  /** Mean life score of the candidate on this seed. */
  score: number;
  /** Mean life score of `easy` in the candidate's seat on this seed. */
  bar: number;
}

export interface QualifyCheck extends CheckBase {
  /**
   * `meanLifeScore`: total score of the seat's lives / number of lives, over all seeds pooled. A
   * life still running when the match ends counts with its score so far.
   */
  metric: "meanLifeScore";
  /** `null` while skipped. */
  score: number | null;
  bar: number | null;
  lives: number | null;
  barLives: number | null;
  perSeed: SeedScore[];
}
