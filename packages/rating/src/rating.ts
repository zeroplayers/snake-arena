import { DEFAULT_RATING_CONFIG, minRankedTicks, type RatingConfig } from "./config.ts";
import { ratioSummary, tQuantile } from "./stats.ts";

/** One counted life: its score and how long it lasted. */
export interface RatedLife {
  readonly score: number;
  /** Ticks alive (`end_tick − start_tick`); at least 1. */
  readonly ticks: number;
}

/**
 * Everything needed to update a version's rating without rereading its lives: the last `window`
 * lives and the all-time life count and time alive. Plain data (see `storage.ts` for the D1 row).
 *
 * The window has to be kept in full: a sliding sum must subtract the life that falls out, and no
 * fixed-size summary remembers which one that is. 200 pairs are a few KB per version, less than
 * fetching the evicted life from `lives` (an `OFFSET 200` scan) on every write.
 */
export interface RatingState {
  /** The most recent lives, oldest first. */
  readonly window: readonly RatedLife[];
  /** Every life recorded for the version, evicted ones included. */
  readonly lives: number;
  /** Ticks alive over every life recorded, evicted ones included (the ranking threshold). */
  readonly ticks: number;
}

export const EMPTY_RATING_STATE: RatingState = Object.freeze({
  window: Object.freeze([]),
  lives: 0,
  ticks: 0,
});

/** A version's rating as shown on the leaderboard and the bot page. */
export interface Rating {
  /** Points per minute alive over the window: Σ score / Σ minutes alive. */
  mean: number;
  /**
   * Half-width of the confidence interval around `mean`; `Infinity` while the window holds fewer
   * than `MIN_EFFECTIVE_LIVES` lives' worth of evidence (`effectiveLives`).
   */
  ci: number;
  /** Lives the rating is over: `min(lives, window)`. */
  n: number;
  /** The window's effective number of lives, `(Σt)² / Σt²`: `n` if all last as long. */
  effectiveLives: number;
  /** Minutes alive the rating is over (the window's). */
  minutes: number;
  /** Every life recorded for the version. */
  lives: number;
  /** Minutes alive over every life recorded. */
  totalMinutes: number;
  /** On the leaderboard: `totalMinutes >= minMinutes`, with a finite interval. */
  ranked: boolean;
}

/**
 * State for a version whose recent lives (oldest first) are `window`, e.g. read back from `lives`
 * to rebuild a rating. Only the last `config.window` are kept; `lives` and `ticks` (all-time)
 * default to the given lives' count and total.
 */
export function createRatingState(
  window: readonly RatedLife[],
  lives: number = window.length,
  ticks?: number,
  config: RatingConfig = DEFAULT_RATING_CONFIG,
): RatingState {
  const checked = window.map(checkLife);
  const given = checked.reduce((t, l) => t + l.ticks, 0);
  const total = ticks ?? given;
  if (!Number.isInteger(lives) || lives < window.length) {
    throw new RangeError(`lives must be an integer >= ${window.length}, got ${lives}`);
  }
  if (!Number.isInteger(total) || total < 0) {
    throw new RangeError(`ticks must be an integer >= 0, got ${total}`);
  }
  return { window: checked.slice(-config.window), lives, ticks: total };
}

/**
 * The state after one more life: O(window), the oldest life drops out once the window is full.
 * Pure; `state` is left as it was.
 */
export function addLife(
  state: RatingState,
  life: RatedLife,
  config: RatingConfig = DEFAULT_RATING_CONFIG,
): RatingState {
  const checked = checkLife(life);
  const keep = state.window.slice(Math.max(0, state.window.length - config.window + 1));
  keep.push(checked);
  return { window: keep, lives: state.lives + 1, ticks: state.ticks + checked.ticks };
}

/**
 * The rating of `state`, or `null` before the first life. O(window).
 *
 * `mean` is the ratio estimator Σ score / Σ minutes over the window, i.e. every life weighs as
 * much as it lasted: a 24-hour life counts for 24 hours, a 5-second one for 5 seconds, however
 * high its own rate (a lucky short life can't swing it, and a long one can't be drowned out by
 * many short ones). `ci` is `t(nEff − 1) × se`, with `se` the delta-method standard error of the
 * ratio (`ratioSummary`), `nEff = (Σt)² / Σt²` the effective number of lives and `t` Student's
 * quantile for the configured `z` (`tQuantile`): wide while a version has few lives' worth of
 * evidence, and unbounded below `MIN_EFFECTIVE_LIVES`. So an hour-long life plus a death at spawn
 * (on purpose or not) is one life's worth, not two, and isn't ranked.
 */
export function rate(
  state: RatingState,
  config: RatingConfig = DEFAULT_RATING_CONFIG,
): Rating | null {
  const window =
    state.window.length > config.window ? state.window.slice(-config.window) : state.window;
  if (window.length === 0) return null;
  const perMinute = config.ticksPerMinute;
  // Points per minute directly: scores × ticks per minute over ticks.
  const { n, nEff, ratio, se } = ratioSummary(
    window.map((l) => l.score * perMinute),
    window.map((l) => l.ticks),
  );
  const ticks = window.reduce((t, l) => t + l.ticks, 0);
  return {
    mean: ratio,
    ci:
      nEff < MIN_EFFECTIVE_LIVES || !Number.isFinite(se)
        ? Number.POSITIVE_INFINITY
        : tQuantile(config.z, nEff - 1) * se,
    n,
    effectiveLives: nEff,
    minutes: ticks / perMinute,
    lives: state.lives,
    totalMinutes: state.ticks / perMinute,
    ranked: nEff >= MIN_EFFECTIVE_LIVES && state.ticks >= minRankedTicks(config),
  };
}

/**
 * Fewest effective lives (`Rating.effectiveLives`) with an interval: below it the window is
 * essentially one life (say an hour-long one and a few short deaths) and `ci` is unbounded.
 */
export const MIN_EFFECTIVE_LIVES = 2;

/**
 * Largest life score magnitude accepted. Real scores are in the thousands to millions (a 24-hour
 * life); the bound keeps a window's sums and squares far from overflow (which would turn the
 * rating and the order into NaN).
 */
export const MAX_LIFE_SCORE = 1e12;
/** Longest life accepted, in ticks: far above any life cap (864 000 is 24 hours). */
export const MAX_LIFE_TICKS = 1e9;

/** The life as stored: a finite score within ±`MAX_LIFE_SCORE`, at least one tick. */
function checkLife(life: RatedLife): RatedLife {
  const { score, ticks } = life;
  if (!(Math.abs(score) <= MAX_LIFE_SCORE)) {
    throw new RangeError(`life score must be finite and within ±${MAX_LIFE_SCORE}, got ${score}`);
  }
  if (!(Number.isInteger(ticks) && ticks >= 0 && ticks <= MAX_LIFE_TICKS)) {
    throw new RangeError(`life ticks must be an integer in [0, ${MAX_LIFE_TICKS}], got ${ticks}`);
  }
  // A life lasts at least the tick it died on; 0 would divide by nothing.
  return { score, ticks: Math.max(1, ticks) };
}
