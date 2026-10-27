import type { TickReport } from "@zerosnake/sandbox";

/**
 * Caps on what the candidate may cost over the whole suite, on top of the sandbox's per-tick
 * budget. Before #60 that budget only counted QuickJS interrupt polls, so a bot could stay
 * "within budget" and still take seconds per tick; the sandbox now charges real cost, and the
 * wall clock remains the backstop for its known gaps (see the sandbox README).
 */
export interface SuiteBudget {
  /**
   * Wall-clock cap in ms, checked between ticks and lives. It only works where the clock moves
   * during computation: in Node, yes; in workerd, `performance.now()` stands still until I/O,
   * so there the Worker's own CPU limit is the backstop. Not deterministic, unlike everything
   * else in the report, but it only decides for bots far slower than any honest one.
   */
  maxMillis: number;
  /** Interrupt polls over all of the candidate's ticks (deterministic). */
  maxInterrupts: number;
  /** Cost units over all of the candidate's ticks (deterministic). */
  maxWork: number;
}

/** Share of the per-tick budget a bot may use on average over the suite. */
export const AVERAGE_BUDGET_SHARE = 0.5;
/** Default {@link SuiteBudget.maxMillis}: the suite is meant to take seconds. */
export const DEFAULT_MAX_MILLIS = 60_000;

/** Which cap was hit, and where. */
export interface Overrun {
  limit: keyof SuiteBudget;
  used: number;
  max: number;
  seed: number;
  /** World tick at which the suite stopped. */
  tick: number;
}

/** What the candidate has cost so far. */
export interface Cost {
  interrupts: number;
  work: number;
}

/**
 * Adds up the candidate's cost across the suite and tells when a cap is hit. This is the one
 * place that reads costs out of a `TickReport`.
 */
export class CostMeter {
  readonly cost: Cost = { interrupts: 0, work: 0 };
  private readonly started: number;

  constructor(
    readonly budget: SuiteBudget,
    private readonly clock: () => number,
  ) {
    this.started = clock();
  }

  /** Charges one tick. Returns the cap it broke, if any. */
  charge(r: TickReport): Omit<Overrun, "seed" | "tick"> | null {
    this.cost.interrupts += r.interrupts;
    this.cost.work += r.work;
    if (this.cost.interrupts > this.budget.maxInterrupts) {
      return { limit: "maxInterrupts", used: this.cost.interrupts, max: this.budget.maxInterrupts };
    }
    if (this.cost.work > this.budget.maxWork) {
      return { limit: "maxWork", used: this.cost.work, max: this.budget.maxWork };
    }
    return this.checkClock();
  }

  /** Checks the wall clock only (after a life is started, say). */
  checkClock(): Omit<Overrun, "seed" | "tick"> | null {
    const elapsed = this.clock() - this.started;
    return elapsed > this.budget.maxMillis
      ? { limit: "maxMillis", used: Math.round(elapsed), max: this.budget.maxMillis }
      : null;
  }
}
