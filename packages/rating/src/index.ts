/**
 * @zerosnake/rating — version rating and leaderboard (SPEC §4 "Rating"). Pure, no runtime deps.
 * A rating is points per minute alive: Σ score / Σ minutes over the last 200 lives.
 *
 *   let state = fromRatingsRow(row) ?? rebuild; // EMPTY_RATING_STATE for a new version
 *   state = addLife(state, { score, ticks });   // O(window)
 *   const row = toRatingsRow(state);            // write back to D1 `ratings`
 *   rate(state);                                // { mean, ci, n, minutes, lives, ranked, ... }
 *   leaderboard(rows);                          // ranked by mean − ci, one ready version per bot
 *
 * `normalizeScore` adjusts a life for the strength of its room; it is off by default (README).
 */
export {
  createRatingConfig,
  DEFAULT_RATING_CONFIG,
  minRankedTicks,
  type RatingConfig,
} from "./config.ts";
export {
  compareRated,
  leaderboard,
  lowerBound,
  type Ranked,
  type RankKey,
  type RatedVersion,
} from "./leaderboard.ts";
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
  MAX_LIFE_SCORE,
  MAX_LIFE_TICKS,
  type RatedLife,
  type Rating,
  type RatingState,
  rate,
} from "./rating.ts";
export {
  type RatioSummary,
  ratioSummary,
  type Summary,
  summarize,
  tQuantile,
} from "./stats.ts";
export {
  decodeWindow,
  encodeWindow,
  fromRatingsRow,
  RAW_SCORING,
  type RatingsRow,
  type Scoring,
  scoringKey,
  toRatingsRow,
} from "./storage.ts";
