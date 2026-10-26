import { DEFAULT_RATING_CONFIG, type RatingConfig } from "./config.ts";
import { summarize } from "./stats.ts";

/**
 * Everything needed to update a version's rating without rereading its lives: the scores of the
 * last `window` lives and the all-time life count. Plain data (see `storage.ts` for the D1 row).
 *
 * The window has to be kept in full: a sliding mean must subtract the score that falls out, and
 * no fixed-size summary remembers which one that is. 200 numbers are a few KB per version, less
 * than fetching the evicted life from `lives` (an `OFFSET 200` scan) on every write.
 */
export interface RatingState {
  /** Scores of the most recent lives, oldest first. */
  readonly scores: readonly number[];
  /** Every life ever recorded for the version, evicted ones included. */
  readonly lives: number;
}

export const EMPTY_RATING_STATE: RatingState = Object.freeze({
  scores: Object.freeze([]),
  lives: 0,
});

/** A version's rating as shown on the leaderboard and the bot page. */
export interface Rating {
  /** Mean score over the window. */
  mean: number;
  /** Half-width of the confidence interval around `mean`; `Infinity` with a single life. */
  ci: number;
  /** Lives the mean is over: `min(lives, window)`. */
  n: number;
  /** Every life recorded for the version. */
  lives: number;
  /** `lives >= minLives`: the version is on the leaderboard. */
  ranked: boolean;
}

/**
 * State for a version whose recent life scores (oldest first) are `scores`, e.g. read back from
 * `lives` to rebuild a rating. Only the last `window` are kept; `lives` defaults to their count.
 */
export function createRatingState(
  scores: readonly number[],
  lives: number = scores.length,
  config: RatingConfig = DEFAULT_RATING_CONFIG,
): RatingState {
  for (const s of scores) checkScore(s);
  if (!Number.isInteger(lives) || lives < scores.length) {
    throw new RangeError(`lives must be an integer >= ${scores.length}, got ${lives}`);
  }
  return { scores: scores.slice(-config.window), lives };
}

/**
 * The state after one more life with `score`: O(window), the oldest score drops out once the
 * window is full. Pure; `state` is left as it was.
 */
export function addLife(
  state: RatingState,
  score: number,
  config: RatingConfig = DEFAULT_RATING_CONFIG,
): RatingState {
  checkScore(score);
  const keep = state.scores.slice(Math.max(0, state.scores.length - config.window + 1));
  keep.push(score);
  return { scores: keep, lives: state.lives + 1 };
}

/** The rating of `state`, or `null` before the first life. O(window). */
export function rate(
  state: RatingState,
  config: RatingConfig = DEFAULT_RATING_CONFIG,
): Rating | null {
  const window =
    state.scores.length > config.window ? state.scores.slice(-config.window) : state.scores;
  if (window.length === 0) return null;
  const { n, mean, sd } = summarize(window);
  return {
    mean,
    ci: n < 2 ? Number.POSITIVE_INFINITY : (config.z * sd) / Math.sqrt(n),
    n,
    lives: state.lives,
    ranked: state.lives >= config.minLives,
  };
}

/**
 * Largest life score magnitude accepted. Real scores are in the thousands; the bound keeps a
 * window's sums and squares far from overflow (which would turn the mean and the order into NaN).
 */
export const MAX_LIFE_SCORE = 1e12;

function checkScore(score: number): void {
  if (!(Math.abs(score) <= MAX_LIFE_SCORE)) {
    throw new RangeError(`life score must be finite and within ±${MAX_LIFE_SCORE}, got ${score}`);
  }
}
