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
  /** How far along `points` the body reaches; the path may run a little past it. */
  bodyLength: number;
  angle: number;
  radius: number;
  length: number;
}

/**
 * Blends a snake between two ticks along its path rather than point by point. The engine lays
 * a body out along the head's trail, so between ticks the head slides from `prev`'s head to
 * `next`'s in a straight line and the body follows it down `prev`'s path, while the body's
 * length blends from one tick's to the other's.
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
  const nextLength = pathLength(next.segments);

  if (!prev || !prevHead || !nextHead || headStep > nextRadius * 20) {
    for (const s of next.segments) pts.push(s.x, s.y);
    out.bodyLength = nextLength;
    out.angle = next.angle;
    out.radius = nextRadius;
    out.length = next.length;
    return out;
  }

  const prevLength = pathLength(prev.segments);
  pts.push(lerp(prevHead.x, nextHead.x, alpha), lerp(prevHead.y, nextHead.y, alpha));
  for (const s of prev.segments) pts.push(s.x, s.y);
  // A snake that grew reaches past `prev`'s tail: borrow the rest of the path from `next`.
  const covered = headStep + prevLength;
  let walked = 0;
  for (let i = 1; i < next.segments.length; i++) {
    const a = next.segments[i - 1] as Vec2;
    const b = next.segments[i] as Vec2;
    walked += distance(a, b);
    if (walked > covered) pts.push(b.x, b.y);
  }

  out.bodyLength = lerp(prevLength, nextLength, alpha);
  out.angle = lerpAngle(prev.angle, next.angle, alpha);
  out.radius = lerp(snakeRadius(prev), nextRadius, alpha);
  out.length = lerp(prev.length, next.length, alpha);
  return out;
}

const distance = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

function pathLength(points: readonly Vec2[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++)
    length += distance(points[i - 1] as Vec2, points[i] as Vec2);
  return length;
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

  let total = 0;
  for (let i = 1; i < n; i++) total += segmentLength(points, i);
  const end = Math.min(length, total);
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
      break;
    }
    walked += len;
  }
  return out.length >> 1;
}

/** Writes the point `d` along a flat polyline into `out` (clamped to its ends). */
export function pointAlong(
  points: readonly number[],
  d: number,
  out: { x: number; y: number },
): void {
  const n = points.length >> 1;
  out.x = points[0] ?? 0;
  out.y = points[1] ?? 0;
  let walked = 0;
  for (let i = 1; i < n; i++) {
    const len = segmentLength(points, i);
    const bx = points[2 * i] as number;
    const by = points[2 * i + 1] as number;
    if (len > 0 && walked + len >= d) {
      const t = Math.max(0, (d - walked) / len);
      out.x += (bx - out.x) * t;
      out.y += (by - out.y) * t;
      return;
    }
    walked += len;
    out.x = bx;
    out.y = by;
  }
}

function segmentLength(points: readonly number[], i: number): number {
  return Math.hypot(
    (points[2 * i] as number) - (points[2 * i - 2] as number),
    (points[2 * i + 1] as number) - (points[2 * i - 1] as number),
  );
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
