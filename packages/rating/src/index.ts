/**
 * @zerosnake/rating — version rating and leaderboard (SPEC §4 "Rating"). Pure, no runtime deps.
 *
 *   let state = fromRatingsRow(row);            // or EMPTY_RATING_STATE for a new version
 *   state = addLife(state, life.score);         // O(window)
 *   const row = toRatingsRow(state);            // write back to D1 `ratings`
 *   rate(state);                                // { mean, ci, n, lives, ranked }
 *   leaderboard(rows);                          // ranked rows, best first
 *
 * `normalizeScore` adjusts a life for the strength of its room; it is off by default (README).
 */
export { createRatingConfig, DEFAULT_RATING_CONFIG, type RatingConfig } from "./config.ts";
export { compareRated, leaderboard, type Ranked, type Rated } from "./leaderboard.ts";
export {
  DEFAULT_NORMALIZATION,
  type NormalizationConfig,
  normalizeScore,
  type RoomMember,
  roomStrength,
} from "./normalize.ts";
export {
  addLife,
  createRatingState,
  EMPTY_RATING_STATE,
  type Rating,
  type RatingState,
  rate,
} from "./rating.ts";
export { type Summary, summarize } from "./stats.ts";
export {
  decodeScores,
  encodeScores,
  fromRatingsRow,
  type RatingsRow,
  toRatingsRow,
} from "./storage.ts";
