import { DEFAULT_RATING_CONFIG, type RatingConfig } from "./config.ts";
import { lowerBound } from "./leaderboard.ts";
import type { NormalizationConfig } from "./normalize.ts";
import { createRatingState, type RatedLife, type RatingState, rate } from "./rating.ts";

/**
 * The D1 `ratings` row of a version (`apps/web/src/db/schema.ts`), minus `version_id` and
 * `updated_at`. `mean`, `ci`, `lowerBound`, `nLives` and `aliveTicks` are what the leaderboard
 * reads; `recentScores` is the state the next update starts from.
 */
export interface RatingsRow {
  /** Points per minute alive over the window. */
  mean: number;
  /** Half-width of the confidence interval, `null` while there is only one life. */
  ci: number | null;
  /** `mean − ci`, the leaderboard's sort key; `null` without an interval. */
  lowerBound: number | null;
  /** All-time lives of the version. */
  nLives: number;
  /** All-time ticks alive of the version (the leaderboard threshold applies to this). */
  aliveTicks: number;
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
    nLives: state.lives,
    aliveTicks: state.ticks,
    recentScores: encodeWindow(state.window.slice(-config.window), scoring),
  };
}

/**
 * The state stored in a row (a missing row is `EMPTY_RATING_STATE`). `null` when it can't be
 * continued: the window was scored differently from `scoring` (normalization was switched on
 * since), or it is in an older format (version 1 held scores without lives' lengths, from when
 * the rating was the mean score per life). Rebuild it from `lives` with `createRatingState`.
 */
export function fromRatingsRow(
  row: Pick<RatingsRow, "nLives" | "aliveTicks" | "recentScores">,
  config: RatingConfig = DEFAULT_RATING_CONFIG,
  scoring: Scoring = RAW_SCORING,
): RatingState | null {
  const w = decodeWindow(row.recentScores);
  if (w === null || w.scoring !== scoring) return null;
  return createRatingState(w.lives, row.nLives, row.aliveTicks, config);
}

/**
 * Stored window shape, version 2: each life as `[score, ticks]`. Finite doubles survive the JSON
 * round trip exactly.
 */
interface StoredWindow {
  v: 2;
  scoring: Scoring;
  lives: [number, number][];
}

export function encodeWindow(lives: readonly RatedLife[], scoring: Scoring = RAW_SCORING): string {
  const w: StoredWindow = { v: 2, scoring, lives: lives.map((l) => [l.score, l.ticks]) };
  return JSON.stringify(w);
}

/**
 * The stored window, or `null` for a version 1 window (scores only, written before the rating
 * became points per minute): it has to be rebuilt. Throws on anything else malformed.
 */
export function decodeWindow(text: string): { scoring: Scoring; lives: RatedLife[] } | null {
  const w: unknown = JSON.parse(text);
  if (typeof w === "object" && w !== null && "v" in w && w.v === 1) return null;
  if (
    typeof w !== "object" ||
    w === null ||
    !("v" in w && w.v === 2) ||
    !("scoring" in w && typeof w.scoring === "string") ||
    !("lives" in w && Array.isArray(w.lives)) ||
    !w.lives.every(
      (l) =>
        Array.isArray(l) &&
        l.length === 2 &&
        l.every((x: unknown) => typeof x === "number" && Number.isFinite(x)),
    )
  ) {
    throw new TypeError(
      'recent_scores must be {"v":2,"scoring":string,"lives":[[score,ticks],...]}',
    );
  }
  return {
    scoring: w.scoring,
    lives: (w.lives as [number, number][]).map(([score, ticks]) => ({ score, ticks })),
  };
}
