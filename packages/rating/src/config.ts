/** Every number the rating depends on (SPEC §4 "Rating"). */
export interface RatingConfig {
  /** The rating is the mean over this many most recent lives. */
  window: number;
  /** A version enters the leaderboard after this many lives. */
  minLives: number;
  /**
   * Normal quantile for the confidence interval: 1.96 is 95%. The interval is
   * `mean ± z × s / √n` with `s` the sample standard deviation of the window.
   */
  z: number;
}

export const DEFAULT_RATING_CONFIG: Readonly<RatingConfig> = Object.freeze({
  window: 200,
  minLives: 30,
  z: 1.96,
});

/** Defaults with `overrides` applied; throws on values the rating can't work with. */
export function createRatingConfig(overrides: Partial<RatingConfig> = {}): RatingConfig {
  const c = { ...DEFAULT_RATING_CONFIG, ...overrides };
  if (!Number.isInteger(c.window) || c.window < 2) {
    throw new RangeError(`window must be an integer >= 2, got ${c.window}`);
  }
  if (!Number.isInteger(c.minLives) || c.minLives < 1) {
    throw new RangeError(`minLives must be an integer >= 1, got ${c.minLives}`);
  }
  if (!(Number.isFinite(c.z) && c.z > 0)) {
    throw new RangeError(`z must be a positive number, got ${c.z}`);
  }
  return c;
}
