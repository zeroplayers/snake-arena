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

export interface RatioSummary {
  n: number;
  /**
   * Effective number of lives, `(Σt)² / Σt²` (Kish): `n` when every life lasts as long, about 1
   * when one life holds nearly all the time. The ratio is as good as that many equal lives.
   */
  nEff: number;
  /** Σy / Σt. */
  ratio: number;
  /**
   * Standard error of `ratio` by the delta method (the classical ratio-estimator variance) with
   * the reliability-weights correction for `nEff` instead of `n`:
   * `√(Σ(yᵢ − ratio·tᵢ)² / (Σt)² · nEff / (nEff − 1))`. `Infinity` while `nEff <= 1`.
   */
  se: number;
}

/**
 * Σy / Σt over pairs `(y, t)` and its standard error. With `y` a life's score and `t` its
 * length, the ratio is the score per unit of time alive, and it estimates `E[y] / E[t]`: by the
 * renewal–reward theorem, what the version earns per unit of time alive in the long run. Each
 * life weighs as much as it lasted: a 5-second life moves the ratio by 5 seconds' worth, however
 * high its own rate. Residuals `yᵢ − ratio·tᵢ` are summed in two passes (as in `summarize`).
 *
 * The variance correction uses the effective sample size, not the count: with an hour-long life
 * and a 1-tick one, the two residuals are forced equal and opposite and tiny, and `n = 2` would
 * call that a precise estimate; `nEff ≈ 1` says there is one life's worth of evidence.
 */
export function ratioSummary(ys: readonly number[], ts: readonly number[]): RatioSummary {
  const n = ys.length;
  if (n !== ts.length) throw new RangeError("ys and ts must have the same length");
  if (n === 0) return { n: 0, nEff: 0, ratio: Number.NaN, se: Number.NaN };
  const total = sum(ts);
  const ratio = sum(ys) / total;
  const nEff = Math.min(n, (total * total) / sum(ts.map((t) => t * t)));
  if (n === 1 || !(nEff > 1)) return { n, nEff, ratio, se: Number.POSITIVE_INFINITY };
  let d = 0;
  let d2 = 0;
  for (let i = 0; i < n; i++) {
    const e = (ys[i] as number) - ratio * (ts[i] as number);
    d += e;
    d2 += e * e;
  }
  const m2 = Math.max(0, d2 - (d * d) / n);
  return { n, nEff, ratio, se: Math.sqrt((m2 / (total * total)) * (nEff / (nEff - 1))) };
}

/**
 * Student's t quantile with `df` degrees of freedom at the probability whose normal quantile is
 * `z` (1.96 → the 97.5% point, for a 95% interval). Cornish–Fisher expansion in `1 / df`
 * (Abramowitz & Stegun 26.7.5, four terms): within 0.1% of the exact value from 3 degrees of
 * freedom, 1% at 2 and 11% low at 1 (11.3 for 12.7), and → `z` as `df` grows.
 */
export function tQuantile(z: number, df: number): number {
  if (!(df >= 1)) return Number.POSITIVE_INFINITY;
  const z2 = z * z;
  const g1 = (z * (z2 + 1)) / 4;
  const g2 = (z * ((5 * z2 + 16) * z2 + 3)) / 96;
  const g3 = (z * (((3 * z2 + 19) * z2 + 17) * z2 - 15)) / 384;
  const g4 = (z * ((((79 * z2 + 776) * z2 + 1482) * z2 - 1920) * z2 - 945)) / 92160;
  return z + g1 / df + g2 / df ** 2 + g3 / df ** 3 + g4 / df ** 4;
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
