import { DEFAULT_RATING_CONFIG, type RatingConfig } from "./config.ts";
import { lowerBound } from "./leaderboard.ts";
import type { NormalizationConfig } from "./normalize.ts";
import { createRatingState, type RatingState, rate } from "./rating.ts";

/**
 * The D1 `ratings` row of a version (`apps/web/src/db/schema.ts`), minus `version_id` and
 * `updated_at`. `mean`, `ci`, `lowerBound` and `nLives` are what the leaderboard reads;
 * `recentScores` is the state the next update starts from. The schema changes this needs are in
 * the package README.
 */
export interface RatingsRow {
  mean: number;
  /** Half-width of the confidence interval, `null` while there is only one life. */
  ci: number | null;
  /** `mean − ci`, the leaderboard's sort key; `null` without an interval. */
  lowerBound: number | null;
  /** All-time lives of the version (the leaderboard threshold applies to this). */
  nLives: number;
  /** `encodeWindow`: the window, oldest first, and how its scores were computed. */
  recentScores: string;
}

/**
 * How the scores in a window were computed: `"raw"` life scores, or normalized with particular
 * settings (`scoringKey`). Stored with the window so raw and normalized scores never mix.
 */
export type Scoring = string;

export const RAW_SCORING: Scoring = "raw";

/** The `Scoring` of lives adjusted with `config` (`"raw"` while normalization is off). */
export function scoringKey(config: NormalizationConfig): Scoring {
  if (!config.enabled) return RAW_SCORING;
  return `norm:${config.reference}:${config.alpha}:${config.maxFactor}`;
}

/** The row to write after `state` changed. Throws before the first life: there is no rating. */
export function toRatingsRow(
  state: RatingState,
  config: RatingConfig = DEFAULT_RATING_CONFIG,
  scoring: Scoring = RAW_SCORING,
): RatingsRow {
  const r = rate(state, config);
  if (!r) throw new RangeError("no lives to rate");
  const ci = Number.isFinite(r.ci) ? r.ci : null;
  return {
    mean: r.mean,
    ci,
    lowerBound: ci === null ? null : lowerBound({ mean: r.mean, ci }),
    nLives: r.lives,
    recentScores: encodeWindow(state.scores.slice(-config.window), scoring),
  };
}

/**
 * The state stored in a row (a missing row is `EMPTY_RATING_STATE`). `null` when the window was
 * scored differently from `scoring`, e.g. normalization was switched on since: rebuild it from
 * `lives` with `createRatingState` instead of adding to it.
 */
export function fromRatingsRow(
  row: Pick<RatingsRow, "nLives" | "recentScores">,
  config: RatingConfig = DEFAULT_RATING_CONFIG,
  scoring: Scoring = RAW_SCORING,
): RatingState | null {
  const w = decodeWindow(row.recentScores);
  return w.scoring === scoring ? createRatingState(w.scores, row.nLives, config) : null;
}

/** Stored window shape, version 1. Finite doubles survive the JSON round trip exactly. */
interface StoredWindow {
  v: 1;
  scoring: Scoring;
  scores: number[];
}

export function encodeWindow(scores: readonly number[], scoring: Scoring = RAW_SCORING): string {
  const w: StoredWindow = { v: 1, scoring, scores: [...scores] };
  return JSON.stringify(w);
}

export function decodeWindow(text: string): { scoring: Scoring; scores: number[] } {
  const w: unknown = JSON.parse(text);
  if (
    typeof w !== "object" ||
    w === null ||
    !("v" in w && w.v === 1) ||
    !("scoring" in w && typeof w.scoring === "string") ||
    !("scores" in w && Array.isArray(w.scores)) ||
    !w.scores.every((x) => typeof x === "number" && Number.isFinite(x))
  ) {
    throw new TypeError('recent_scores must be {"v":1,"scoring":string,"scores":number[]}');
  }
  return { scoring: w.scoring, scores: w.scores };
}
