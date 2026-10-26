import { DEFAULT_RATING_CONFIG, type RatingConfig } from "./config.ts";

/** What ordering looks at; any row carrying these (a D1 `ratings` join, a `Rating`) works. */
export interface Rated {
  /** Stable key for the last tie-break, e.g. the version id. */
  id: string;
  mean: number;
  /** Half-width of the confidence interval; `null` or `Infinity` when unknown (widest). */
  ci: number | null;
  /** All-time lives. */
  lives: number;
}

export type Ranked<T> = T & { rank: number };

/**
 * Leaderboard order: higher mean first; on equal means the narrower interval (the better
 * measured version), then more lives. Returns < 0 when `a` goes first. Ignores `id`.
 */
export function compareRated(a: Omit<Rated, "id">, b: Omit<Rated, "id">): number {
  return b.mean - a.mean || width(a.ci) - width(b.ci) || b.lives - a.lives;
}

/**
 * The leaderboard: versions with at least `minLives` lives, best first, each with a 1-based
 * `rank`. Rows that tie on mean, interval and lives share a rank ("1, 2, 2, 4") and are listed
 * by `id`, so the output doesn't depend on input order. Extra fields are kept, so the same call
 * serves the web leaderboard (#28) and the arena.
 */
export function leaderboard<T extends Rated>(
  rows: readonly T[],
  config: Pick<RatingConfig, "minLives"> = DEFAULT_RATING_CONFIG,
): Ranked<T>[] {
  const sorted = rows
    .filter((r) => r.lives >= config.minLives)
    .sort((a, b) => compareRated(a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: Ranked<T>[] = [];
  for (const [i, row] of sorted.entries()) {
    const prev = out[i - 1];
    const rank = prev && compareRated(prev, row) === 0 ? prev.rank : i + 1;
    out.push({ ...row, rank });
  }
  return out;
}

/** `Infinity − Infinity` is NaN, so unknown widths compare through this. */
function width(ci: number | null): number {
  return ci === null || !Number.isFinite(ci) ? Number.MAX_VALUE : ci;
}
