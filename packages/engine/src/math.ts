/**
 * Deterministic math. `Math.sin`/`Math.cos` are implementation-defined, so a replay could drift
 * between V8 (server), QuickJS and a browser. These use only + − × ÷, round and sqrt, which
 * IEEE-754 pins down exactly.
 */

export const PI = Math.PI;
export const TAU = 2 * Math.PI;
const HALF_PI = Math.PI / 2;

/** Wraps an angle into (-π, π]. */
export function wrapAngle(a: number): number {
  let r = a - TAU * Math.round(a / TAU);
  if (r <= -PI) r += TAU;
  return r;
}

/** Taylor series to x^17 on [-π/2, π/2]; error < 1e-13. */
export function sin(a: number): number {
  let x = wrapAngle(a);
  if (x > HALF_PI) x = PI - x;
  else if (x < -HALF_PI) x = -PI - x;
  const x2 = x * x;
  return (
    x *
    (1 +
      x2 *
        (-1 / 6 +
          x2 *
            (1 / 120 +
              x2 *
                (-1 / 5040 +
                  x2 *
                    (1 / 362880 +
                      x2 *
                        (-1 / 39916800 +
                          x2 *
                            (1 / 6227020800 +
                              x2 * (-1 / 1307674368000 + x2 / 355687428096000))))))))
  );
}

export function cos(a: number): number {
  return sin(a + HALF_PI);
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * First time t in [0, 1] at which a point starting at offset (px, py) and moving by (vx, vy)
 * comes within `r` of the origin, or -1 if it doesn't. 0 if it starts inside.
 */
export function firstContact(px: number, py: number, vx: number, vy: number, r: number): number {
  const c = px * px + py * py - r * r;
  if (c <= 0) return 0;
  const b = px * vx + py * vy;
  if (b >= 0) return -1;
  const a = vx * vx + vy * vy;
  const disc = b * b - a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / a;
  return t <= 1 ? t : -1;
}

/**
 * Time t in [0, 1] at which a point moving from p0 by v leaves the square of half-side h
 * centred on the origin (0 if it starts outside, 1 if it doesn't leave).
 */
export function exitTime(px: number, py: number, vx: number, vy: number, h: number): number {
  let t = 1;
  if (vx > 0) t = Math.min(t, (h - px) / vx);
  else if (vx < 0) t = Math.min(t, (-h - px) / vx);
  if (vy > 0) t = Math.min(t, (h - py) / vy);
  else if (vy < 0) t = Math.min(t, (-h - py) / vy);
  return clamp(t, 0, 1);
}

/** Chebyshev norm: a point is inside the square of half-side h iff this is at most h. */
export function squareNorm(x: number, y: number): number {
  return Math.max(Math.abs(x), Math.abs(y));
}

/** Arctangent of t in [0, 1]: two half-angle reductions, then the series to t^21. */
function atanUnit(t: number): number {
  const r = t / (1 + Math.sqrt(1 + t * t));
  const u = r / (1 + Math.sqrt(1 + r * r)); // |u| <= tan(π/16) ≈ 0.2
  const u2 = u * u;
  let s = 0;
  for (let k = 21; k >= 3; k -= 2) s = u2 * (1 / k - s);
  return 4 * u * (1 - s);
}

/** Deterministic `Math.atan2`: the angle of (x, y) in [-π, π]; 0 for the origin. */
export function atan2(y: number, x: number): number {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (ax === 0 && ay === 0) return 0;
  let a = ay <= ax ? atanUnit(ay / ax) : HALF_PI - atanUnit(ax / ay);
  if (x < 0) a = PI - a;
  return y < 0 ? -a : a;
}
