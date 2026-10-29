/** Every number the rating depends on (SPEC §4 "Rating"). */
export interface RatingConfig {
  /** The rating is over this many most recent lives (time-weighted: see `rate`). */
  window: number;
  /**
   * A version enters the leaderboard once its counted lives add up to this many minutes alive
   * (all-time in its stint, not just the window), and it has at least two of them.
   */
  minMinutes: number;
  /**
   * Normal quantile of the confidence interval: 1.96 is 95%. It is turned into Student's t with
   * `n − 1` degrees of freedom (`tQuantile`), so a version with few lives gets a wide interval.
   */
  z: number;
  /** Ticks per minute of game time (`TICK_RATE` 10 × 60), to turn ticks alive into minutes. */
  ticksPerMinute: number;
}

export const DEFAULT_RATING_CONFIG: Readonly<RatingConfig> = Object.freeze({
  window: 200,
  minMinutes: 60,
  z: 1.96,
  ticksPerMinute: 600,
});

/** Defaults with `overrides` applied; throws on values the rating can't work with. */
export function createRatingConfig(overrides: Partial<RatingConfig> = {}): RatingConfig {
  const c = { ...DEFAULT_RATING_CONFIG, ...overrides };
  if (!Number.isInteger(c.window) || c.window < 2) {
    throw new RangeError(`window must be an integer >= 2, got ${c.window}`);
  }
  if (!(Number.isFinite(c.minMinutes) && c.minMinutes >= 0)) {
    throw new RangeError(`minMinutes must be a number >= 0, got ${c.minMinutes}`);
  }
  if (!(Number.isFinite(c.z) && c.z > 0)) {
    throw new RangeError(`z must be a positive number, got ${c.z}`);
  }
  if (!(Number.isFinite(c.ticksPerMinute) && c.ticksPerMinute > 0)) {
    throw new RangeError(`ticksPerMinute must be a positive number, got ${c.ticksPerMinute}`);
  }
  return c;
}

/** Ticks alive a version needs before it is ranked: `minMinutes` in ticks. */
export function minRankedTicks(config: Pick<RatingConfig, "minMinutes" | "ticksPerMinute">) {
  return Math.ceil(config.minMinutes * config.ticksPerMinute);
}
