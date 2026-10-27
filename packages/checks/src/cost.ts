import type { TickReport } from "@zerosnake/sandbox";

/**
 * Caps on what the candidate may cost over the whole suite, on top of the sandbox's per-tick
 * budget. They exist because that budget doesn't bound CPU yet: it counts QuickJS interrupt
 * polls, which come once per ~4,300 loop iterations however long the loop body is, so a bot can
 * stay "within budget" and still take seconds per tick (#60). Until the sandbox meters code by
 * its real cost, these keep a check from running for hours.
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
  /** Native work units over all of the candidate's ticks (deterministic). */
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
 * place that reads costs out of a `TickReport`: when the sandbox gets a real per-opcode meter
 * (#60), its unit is charged here, and the API and report shape stay as they are.
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
