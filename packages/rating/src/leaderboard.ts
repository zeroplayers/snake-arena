import { DEFAULT_RATING_CONFIG, type RatingConfig } from "./config.ts";

/**
 * One version as the leaderboard sees it. Field names are the D1 ones (`ratings` joined with
 * `versions`), so a Drizzle row with these selected goes in as is.
 */
export interface RatedVersion {
  versionId: string;
  botId: string;
  /** `versions.status`; only `"ready"` (the bot's active version) is ranked. */
  status: string;
  /** Mean score over the window (`ratings.mean`). */
  mean: number;
  /** Half-width of the confidence interval; `null` or `Infinity` when unknown. */
  ci: number | null;
  /** All-time lives (`ratings.n_lives`). */
  nLives: number;
}

export type RankKey = Pick<RatedVersion, "mean" | "ci" | "nLives">;

export type Ranked<T> = T & {
  /** 1-based; rows that tie on every key share it. */
  rank: number;
  /** `mean − ci`, what the order is by; `-Infinity` without an interval. */
  lowerBound: number;
};

/**
 * Lower end of the confidence interval: what the leaderboard sorts by. Ranking by the point
 * mean rewards luck: a 30-life mean is off by about ±60% (life scores are heavy-tailed), so the
 * best of a few fresh versions of the same code would outrank a truly better, well-measured one.
 */
export function lowerBound(r: Pick<RatedVersion, "mean" | "ci">): number {
  return r.ci !== null && Number.isFinite(r.ci) ? r.mean - r.ci : Number.NEGATIVE_INFINITY;
}

/**
 * Leaderboard order: higher lower bound (`mean − ci`) first; then the narrower interval, then
 * more lives. Returns < 0 when `a` goes first.
 */
export function compareRated(a: RankKey, b: RankKey): number {
  return (
    order(lowerBound(b), lowerBound(a)) || order(width(a.ci), width(b.ci)) || b.nLives - a.nLives
  );
}

/**
 * The leaderboard, best first, each row with its `rank` and `lowerBound`. Rules:
 *
 * - only `status === "ready"` versions with at least `minLives` lives are ranked, so archived
 *   versions (frozen ratings) can't stay on the board;
 * - at most one version per bot, the best-ordered one (D1 allows one ready version per bot, so
 *   this is a guard);
 * - order by `compareRated`, then `versionId`, so the output doesn't depend on input order;
 * - rows that tie on lower bound, interval and lives share a rank ("1, 2, 2, 4").
 *
 * Other fields of the rows are kept.
 */
export function leaderboard<T extends RatedVersion>(
  rows: readonly T[],
  config: Pick<RatingConfig, "minLives"> = DEFAULT_RATING_CONFIG,
): Ranked<T>[] {
  const sorted = rows
    .filter((r) => r.status === "ready" && r.nLives >= config.minLives)
    .sort((a, b) => compareRated(a, b) || order(a.versionId, b.versionId));
  const bots = new Set<string>();
  const out: Ranked<T>[] = [];
  for (const row of sorted) {
    if (bots.has(row.botId)) continue;
    bots.add(row.botId);
    const prev = out.at(-1);
    const rank = prev && compareRated(prev, row) === 0 ? prev.rank : out.length + 1;
    out.push({ ...row, rank, lowerBound: lowerBound(row) });
  }
  return out;
}

function order<T extends number | string>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Unknown widths sort as the widest. */
function width(ci: number | null): number {
  return ci === null || !Number.isFinite(ci) ? Number.POSITIVE_INFINITY : ci;
}
