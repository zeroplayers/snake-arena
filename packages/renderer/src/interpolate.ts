import type { RenderFrame, RenderSnake } from "./types";

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
  /** Flat `[x0, y0, x1, y1, ...]`, head first. */
  readonly points: number[];
  angle: number;
  radius: number;
  length: number;
}

/**
 * Blends a snake between two ticks point by point. Point `i` of `prev` moves to point `i` of
 * `next`, which follows the body path when the engine shifts segments along it. If the head
 * jumped (respawn) or there is no previous state, `next` is used as is.
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
  const n = next.segments.length;
  const prevHead = prev?.segments[0];
  const nextHead = next.segments[0];
  const teleported =
    !prevHead ||
    !nextHead ||
    Math.hypot(nextHead.x - prevHead.x, nextHead.y - prevHead.y) > nextRadius * 20;

  if (!prev || teleported) {
    for (const s of next.segments) pts.push(s.x, s.y);
    out.angle = next.angle;
    out.radius = nextRadius;
    out.length = next.length;
    return out;
  }

  const ps = prev.segments;
  const last = ps[ps.length - 1];
  for (let i = 0; i < n; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i < n
    const b = next.segments[i]!;
    const a = ps[i] ?? last ?? b;
    pts.push(lerp(a.x, b.x, alpha), lerp(a.y, b.y, alpha));
  }
  out.angle = lerpAngle(prev.angle, next.angle, alpha);
  out.radius = lerp(snakeRadius(prev), nextRadius, alpha);
  out.length = lerp(prev.length, next.length, alpha);
  return out;
}

/**
 * Walks a flat polyline from its first point and writes evenly spaced points into `out`
 * (flat, same layout). Always emits the first point; the remainder shorter than `spacing`
 * is dropped. Returns the number of points written.
 */
export function resamplePolyline(
  points: readonly number[],
  spacing: number,
  out: number[],
): number {
  out.length = 0;
  const n = points.length >> 1;
  if (n === 0) return 0;
  out.push(points[0] as number, points[1] as number);
  if (n === 1 || spacing <= 0) return 1;

  let carry = 0; // distance already walked since the last emitted point
  for (let i = 1; i < n; i++) {
    const ax = points[2 * i - 2] as number;
    const ay = points[2 * i - 1] as number;
    const bx = points[2 * i] as number;
    const by = points[2 * i + 1] as number;
    const len = Math.hypot(bx - ax, by - ay);
    if (len === 0) continue;
    let d = spacing - carry;
    while (d <= len) {
      const t = d / len;
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
      d += spacing;
    }
    carry = len - (d - spacing);
  }
  return out.length >> 1;
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
