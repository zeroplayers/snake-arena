import type { RenderFrame, RenderSnake, Vec2 } from "./types.ts";

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Interpolates angles along the shortest arc. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** Body half-width when the engine doesn't send one: grows slowly with length. */
export function defaultSnakeRadius(length: number): number {
  return 0.8 + Math.sqrt(Math.max(0, length)) * 0.08;
}

export function snakeRadius(snake: RenderSnake): number {
  return snake.radius ?? defaultSnakeRadius(snake.length);
}

export interface InterpolatedSnake {
  /** Flat `[x0, y0, x1, y1, ...]`, head first: the path the body lies along. */
  readonly points: number[];
  /** Length of `points`. */
  pathLength: number;
  /** How far along `points` the body reaches; the path may run a little past it. */
  bodyLength: number;
  /** False when `next` was used as is (no previous tick, or a respawn). */
  blended: boolean;
  angle: number;
  radius: number;
  length: number;
}

/**
 * Blends a snake between two ticks along its path rather than point by point. The engine lays
 * a body out along the head's trail, so between ticks the head slides from `prev`'s head to
 * `next`'s in a straight line and the body follows it down `prev`'s path (continued along
 * `next`'s where the snake grew past its old tail), while the tail slides from where `prev`'s
 * is on that path to where `next`'s is.
 *
 * Moving point `i` of `prev` to point `i` of `next` instead cuts every bend a little mid-tick
 * and the body's spacing changes whenever the snake grows, so the error adds up along the body:
 * a long, coiled snake's tail used to surge back and forth every tick.
 *
 * If the head jumped (respawn) or there is no previous state, `next` is used as is.
 */
export function interpolateSnake(
  prev: RenderSnake | undefined,
  next: RenderSnake,
  alpha: number,
  out: InterpolatedSnake,
): InterpolatedSnake {
  const pts = out.points;
  pts.length = 0;
  const nextRadius = snakeRadius(next);
  const prevHead = prev?.segments[0];
  const nextHead = next.segments[0];
  const headStep = prevHead && nextHead ? distance(prevHead, nextHead) : 0;

  if (!prev || !prevHead || !nextHead || headStep > nextRadius * 20) {
    for (const s of next.segments) pts.push(s.x, s.y);
    out.pathLength = out.bodyLength = polylineLength(pts);
    out.blended = false;
    out.angle = next.angle;
    out.radius = nextRadius;
    out.length = next.length;
    return out;
  }

  const blend = blendFor(prev, next, headStep);
  const back = alpha * headStep; // from the blended head back to `prev`'s
  pts.push(lerp(prevHead.x, nextHead.x, alpha), lerp(prevHead.y, nextHead.y, alpha));
  for (const v of blend.path) pts.push(v);
  out.pathLength = back + blend.length;
  out.bodyLength = back + lerp(blend.prevTail, blend.nextTail, alpha);
  out.blended = true;
  out.angle = lerpAngle(prev.angle, next.angle, alpha);
  out.radius = lerp(snakeRadius(prev), nextRadius, alpha);
  out.length = lerp(prev.length, next.length, alpha);
  return out;
}

/** The part of a blend between two ticks that doesn't change with `alpha`. */
interface PathBlend {
  readonly prev: RenderSnake;
  /** Flat, from `prev`'s head down its body, then on along `next`'s body if that is longer. */
  readonly path: number[];
  readonly length: number;
  /** Where `prev`'s and `next`'s tails are along `path`. */
  readonly prevTail: number;
  readonly nextTail: number;
}

/** Keyed by the later tick's snake: a frame pair is drawn many times. */
const blends = new WeakMap<RenderSnake, PathBlend>();

function blendFor(prev: RenderSnake, next: RenderSnake, headStep: number): PathBlend {
  const cached = blends.get(next);
  if (cached?.prev === prev) return cached;

  const path: number[] = [];
  for (const s of prev.segments) path.push(s.x, s.y);
  const prevTail = polylineLength(path);
  const ahead: number[] = [];
  for (const s of next.segments) ahead.push(s.x, s.y);
  const nextLength = polylineLength(ahead);
  // How far a tail can be from where the other tick's path length puts it: the two ticks
  // sample the trail at different points, and the body may have grown or shrunk.
  const slack =
    3 * Math.max(longestSegment(path), longestSegment(ahead)) +
    Math.abs(nextLength - prevTail) +
    headStep;

  // `prev`'s tail on `next`'s path. If `next` goes on past it, the snake grew: follow `next`.
  const n = ahead.length; // flat
  const where = project(
    ahead,
    path[path.length - 2] as number,
    path[path.length - 1] as number,
    headStep + prevTail,
    slack,
  );
  if (nextLength - where.along > 1e-6) {
    let from = 2 * where.segment;
    if (ahead[from] === path[path.length - 2] && ahead[from + 1] === path[path.length - 1])
      from += 2;
    for (let i = from; i < n; i++) path.push(ahead[i] as number);
    const length = polylineLength(path);
    return remember(next, { prev, path, length, prevTail, nextTail: length });
  }

  // `next`'s tail is on `prev`'s path, give or take how differently the two ticks cut corners:
  // route the path through it, so the tail ends the tick exactly where the next one starts it.
  const on = project(
    path,
    ahead[n - 2] as number,
    ahead[n - 1] as number,
    nextLength - headStep,
    slack,
  );
  if (on.segment === 0) return remember(next, { prev, path, length: 0, prevTail: 0, nextTail: 0 });
  if (on.d2 === 0)
    return remember(next, { prev, path, length: prevTail, prevTail, nextTail: on.along });
  path.splice(2 * on.segment, 0, ahead[n - 2] as number, ahead[n - 1] as number);
  const length = polylineLength(path);
  const nextTail = polylineLength(path.slice(0, 2 * on.segment + 2));
  return remember(next, { prev, path, length, prevTail: length, nextTail });
}

function remember(next: RenderSnake, blend: PathBlend): PathBlend {
  blends.set(next, blend);
  return blend;
}

/**
 * The point of a flat polyline nearest to (x, y), looking only within `slack` of `around` along
 * it: a coiled body passes the same spot many times. Returns how far along the polyline it is,
 * the index of the point ending its segment and the squared distance to it.
 */
function project(
  points: readonly number[],
  x: number,
  y: number,
  around: number,
  slack: number,
): { along: number; segment: number; d2: number } {
  const n = points.length >> 1;
  let best = { along: 0, segment: Math.min(1, n - 1), d2: Number.POSITIVE_INFINITY };
  let walked = 0;
  for (let i = 1; i < n; i++) {
    const ax = points[2 * i - 2] as number;
    const ay = points[2 * i - 1] as number;
    const dx = (points[2 * i] as number) - ax;
    const dy = (points[2 * i + 1] as number) - ay;
    const len2 = dx * dx + dy * dy;
    const len = Math.sqrt(len2);
    if (walked + len >= around - slack && walked <= around + slack) {
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
      const ex = ax + dx * t - x;
      const ey = ay + dy * t - y;
      const d2 = ex * ex + ey * ey;
      if (d2 < best.d2) {
        best = { along: walked + len * t, segment: i, d2 };
      }
    }
    walked += len;
  }
  return best;
}

const distance = (a: Vec2, b: Vec2): number => Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);

function polylineLength(points: readonly number[]): number {
  let length = 0;
  for (let i = 1; i < points.length >> 1; i++) length += segmentLength(points, i);
  return length;
}

function longestSegment(points: readonly number[]): number {
  let longest = 0;
  for (let i = 1; i < points.length >> 1; i++)
    longest = Math.max(longest, segmentLength(points, i));
  return longest;
}

/** Spaced points closer than this many spacings to the end are left out. */
const END_GAP = 0.25;

/**
 * Lays points along a flat polyline (same layout as `out`): one every `spacing` from its first
 * point, then the end point, exactly `length` along it (or at its end, if the polyline is
 * shorter). A spaced point within `END_GAP` spacings of the end is left out, so the end never
 * lands on top of one. Returns the number of points written.
 */
export function resamplePolyline(
  points: readonly number[],
  spacing: number,
  out: number[],
  length = Number.POSITIVE_INFINITY,
): number {
  out.length = 0;
  const n = points.length >> 1;
  if (n === 0) return 0;
  out.push(points[0] as number, points[1] as number);

  const end = Number.isFinite(length) ? length : polylineLength(points);
  if (!(end > 0)) return 1;

  const last = spacing > 0 ? end - spacing * END_GAP : Number.NEGATIVE_INFINITY;
  let next = spacing;
  let walked = 0; // distance from the first point to the start of segment i
  for (let i = 1; i < n; i++) {
    const len = segmentLength(points, i);
    if (len === 0) continue;
    const ax = points[2 * i - 2] as number;
    const ay = points[2 * i - 1] as number;
    const bx = points[2 * i] as number;
    const by = points[2 * i + 1] as number;
    for (; next < last && next <= walked + len; next += spacing) {
      const t = (next - walked) / len;
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
    if (end <= walked + len) {
      const t = (end - walked) / len;
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
      return out.length >> 1;
    }
    walked += len;
  }
  // The polyline is shorter than `length`: end on its last point.
  if (walked > 0) out.push(points[2 * n - 2] as number, points[2 * n - 1] as number);
  return out.length >> 1;
}

/** Writes the point `back` before the end of a flat polyline into `out` (clamped to its ends). */
export function pointFromEnd(
  points: readonly number[],
  back: number,
  out: { x: number; y: number },
): void {
  let i = (points.length >> 1) - 1;
  out.x = points[2 * i] ?? 0;
  out.y = points[2 * i + 1] ?? 0;
  let walked = 0;
  for (; i > 0; i--) {
    const len = segmentLength(points, i);
    const ax = points[2 * i - 2] as number;
    const ay = points[2 * i - 1] as number;
    if (len > 0 && walked + len >= back) {
      const t = Math.max(0, (back - walked) / len);
      out.x += (ax - out.x) * t;
      out.y += (ay - out.y) * t;
      return;
    }
    walked += len;
    out.x = ax;
    out.y = ay;
  }
}

function segmentLength(points: readonly number[], i: number): number {
  const dx = (points[2 * i] as number) - (points[2 * i - 2] as number);
  const dy = (points[2 * i + 1] as number) - (points[2 * i - 1] as number);
  return Math.sqrt(dx * dx + dy * dy);
}

export interface FrameSample {
  readonly prev: RenderFrame;
  readonly next: RenderFrame;
  readonly alpha: number;
}

/**
 * Buffers incoming ticks and plays them back on a smooth clock, a little behind the newest
 * tick so there is always a pair to interpolate between. Ticks arriving late or early nudge
 * the playback rate instead of making it jump.
 */
export class FrameBuffer {
  private frames: RenderFrame[] = [];
  private playTick = 0;

  constructor(
    /** Simulation ticks per second. */
    private readonly tps = 10,
    /** How many ticks playback trails the newest frame. */
    private readonly delayTicks = 1,
    private readonly capacity = 16,
  ) {}

  push(frame: RenderFrame): void {
    const latest = this.frames[this.frames.length - 1];
    if (latest && frame.tick <= latest.tick) {
      // Rewind (new match, replay seek): start over.
      this.clear();
    }
    if (this.frames.length === 0) this.playTick = frame.tick;
    this.frames.push(frame);
    if (this.frames.length > this.capacity) this.frames.shift();
  }

  clear(): void {
    this.frames = [];
  }

  get latest(): RenderFrame | undefined {
    return this.frames[this.frames.length - 1];
  }

  /** Advances the clock by `dt` seconds and returns the pair of frames to draw. */
  advance(dt: number): FrameSample | undefined {
    const first = this.frames[0];
    const latest = this.latest;
    if (!first || !latest) return undefined;

    const target = latest.tick - this.delayTicks;
    const lag = target - this.playTick;
    if (Math.abs(lag) > 4) {
      this.playTick = target;
    } else {
      // Speed up when behind, slow down when ahead: rate in [0.5, 1.5].
      const rate = 1 + Math.max(-0.5, Math.min(0.5, lag * 0.5));
      this.playTick += dt * this.tps * rate;
    }
    this.playTick = Math.max(first.tick, Math.min(latest.tick, this.playTick));
    return this.sample(this.playTick);
  }

  /** Pair of buffered frames around `tick`. */
  sample(tick: number): FrameSample | undefined {
    const frames = this.frames;
    if (frames.length === 0) return undefined;
    let i = frames.length - 1;
    while (i > 0 && (frames[i] as RenderFrame).tick > tick) i--;
    const prev = frames[i] as RenderFrame;
    const next = frames[i + 1] ?? prev;
    const span = next.tick - prev.tick;
    const alpha = span > 0 ? Math.max(0, Math.min(1, (tick - prev.tick) / span)) : 0;
    return { prev, next, alpha };
  }
}
