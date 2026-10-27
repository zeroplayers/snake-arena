export interface Summary {
  n: number;
  mean: number;
  /** Sample standard deviation (n − 1 in the denominator); 0 for a single value. */
  sd: number;
}

/**
 * Mean and sample standard deviation of `xs` in two passes: a compensated (Neumaier) sum for the
 * mean, then the corrected two-pass sum of squares (Chan, Golub & LeVeque). Unlike running
 * Σx and Σx² it doesn't cancel catastrophically when the spread is tiny next to the values.
 */
export function summarize(xs: readonly number[]): Summary {
  const n = xs.length;
  if (n === 0) return { n: 0, mean: Number.NaN, sd: Number.NaN };
  const mean = sum(xs) / n;
  if (n === 1) return { n, mean, sd: 0 };
  let d = 0;
  let d2 = 0;
  for (const x of xs) {
    const e = x - mean;
    d += e;
    d2 += e * e;
  }
  const m2 = Math.max(0, d2 - (d * d) / n);
  return { n, mean, sd: Math.sqrt(m2 / (n - 1)) };
}

/** Neumaier's compensated sum. */
export function sum(xs: readonly number[]): number {
  let s = 0;
  let c = 0;
  for (const x of xs) {
    const t = s + x;
    c += Math.abs(s) >= Math.abs(x) ? s - t + x : x - t + s;
    s = t;
  }
  return s + c;
}
