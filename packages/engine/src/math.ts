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

/** Time t in [0, 1] at which a point moving from p0 by v leaves the disc of radius r. */
export function exitTime(px: number, py: number, vx: number, vy: number, r: number): number {
  const a = vx * vx + vy * vy;
  if (a === 0) return 0;
  const b = px * vx + py * vy;
  const c = px * px + py * py - r * r;
  const disc = b * b - a * c;
  if (disc < 0) return 0;
  return clamp((-b + Math.sqrt(disc)) / a, 0, 1);
}
