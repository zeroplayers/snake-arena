import { DEFAULT_RATING_CONFIG, type RatingConfig } from "./config.ts";
import { createRatingState, type RatingState, rate } from "./rating.ts";

/**
 * The D1 `ratings` row of a version (`apps/web/src/db/schema.ts`), minus `version_id` and
 * `updated_at`. `mean`, `ci` and `nLives` are what the leaderboard reads; `recentScores` is the
 * state the next update starts from. It needs two schema changes, see the package README:
 * a `recent_scores TEXT` column, and `ci` nullable (no interval with a single life).
 */
export interface RatingsRow {
  mean: number;
  /** Half-width of the confidence interval, `null` while there is only one life. */
  ci: number | null;
  /** All-time lives of the version (the leaderboard threshold applies to this). */
  nLives: number;
  /** `encodeScores(state.scores)`: the window, oldest first, as a JSON array. */
  recentScores: string;
}

/** The row to write after `state` changed. Throws before the first life: there is no rating. */
export function toRatingsRow(
  state: RatingState,
  config: RatingConfig = DEFAULT_RATING_CONFIG,
): RatingsRow {
  const r = rate(state, config);
  if (!r) throw new RangeError("no lives to rate");
  return {
    mean: r.mean,
    ci: Number.isFinite(r.ci) ? r.ci : null,
    nLives: r.lives,
    recentScores: encodeScores(state.scores.slice(-config.window)),
  };
}

/** The state stored in a row; a missing row is `EMPTY_RATING_STATE`. */
export function fromRatingsRow(
  row: Pick<RatingsRow, "nLives" | "recentScores">,
  config: RatingConfig = DEFAULT_RATING_CONFIG,
): RatingState {
  return createRatingState(decodeScores(row.recentScores), row.nLives, config);
}

/** JSON array of numbers; every finite double survives the round trip exactly. */
export function encodeScores(scores: readonly number[]): string {
  return JSON.stringify(scores);
}

export function decodeScores(text: string): number[] {
  const v: unknown = JSON.parse(text);
  if (!Array.isArray(v) || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
    throw new TypeError("recent_scores must be a JSON array of finite numbers");
  }
  return v;
}
