import type { MatchSource, TickSnapshot } from "./types.ts";

export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16] as const;

/** Ticks shown before a death when jumping to it. */
export const DEATH_LEAD_TICKS = 30;

export interface PlaybackSample {
  readonly prev: TickSnapshot;
  readonly next: TickSnapshot;
  readonly alpha: number;
}

/**
 * The viewer's clock: a fractional playhead over a `MatchSource`, with pause, speed and seek.
 * No DOM, so it is unit-tested on its own. While playing it asks the source for the tick
 * ahead of the playhead, which for a live engine means simulating it just in time.
 */
export class Playback {
  /** Fractional tick on screen. */
  position: number;
  speed = 1;
  private paused = false;
  private stopAt: number | undefined;

  constructor(readonly source: MatchSource) {
    this.position = source.firstTick;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Integer tick whose state is on screen (the earlier of the two being blended). */
  get tick(): number {
    return Math.floor(this.position);
  }

  /** Whether the playhead is at the newest tick of a match that is still going. */
  get atLiveEdge(): boolean {
    return this.source.endTick === undefined && this.position >= this.source.lastTick - 1;
  }

  play(): void {
    if (this.source.endTick !== undefined && this.position >= this.source.endTick) {
      this.position = this.source.firstTick;
    }
    this.paused = false;
  }

  pause(): void {
    this.paused = true;
    this.stopAt = undefined;
  }

  toggle(): void {
    if (this.paused) this.play();
    else this.pause();
  }

  setSpeed(speed: number): void {
    if (speed > 0 && Number.isFinite(speed)) this.speed = speed;
  }

  /** Next or previous entry of `SPEEDS`. */
  stepSpeed(direction: 1 | -1): void {
    const i = SPEEDS.findIndex((s) => s >= this.speed);
    const at = i < 0 ? SPEEDS.length - 1 : i;
    const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, at + direction))];
    if (next !== undefined) this.speed = next;
  }

  /** Moves the playhead; a tick the source doesn't have yet is requested first. */
  seek(tick: number): void {
    this.stopAt = undefined;
    this.position = this.clamp(tick, true);
  }

  /** Moves by whole ticks and pauses, for frame-by-frame stepping. */
  stepBy(ticks: number): void {
    this.seek(Math.round(this.position) + ticks);
    this.paused = true;
  }

  /** Goes to the newest tick and keeps playing from there. */
  goLive(): void {
    this.seek(this.source.lastTick);
    this.paused = false;
  }

  /**
   * Plays the lead-up to a death and pauses on the last tick the snake was alive. Returns
   * false if the life hasn't ended (as far as the source knows).
   */
  jumpToDeath(lifeId: string, lead = DEATH_LEAD_TICKS): boolean {
    const life = this.source.life(lifeId);
    if (!life?.death) return false;
    const last = life.death.tick - 1;
    this.seek(Math.max(life.bornTick, last - lead));
    this.stopAt = last;
    this.paused = false;
    return true;
  }

  /** Advances the playhead by `dt` seconds of wall-clock time. */
  update(dt: number): void {
    if (this.paused) {
      this.position = this.clamp(this.position, false);
      return;
    }
    let target = this.position + dt * this.source.info.tps * this.speed;
    if (this.stopAt !== undefined && target >= this.stopAt) {
      target = this.stopAt;
      this.stopAt = undefined;
      this.paused = true;
    }
    this.position = this.clamp(target, true);
    const end = this.source.endTick;
    if (end !== undefined && this.position >= end) this.paused = true;
  }

  /** The two snapshots around the playhead and the blend between them. */
  sample(): PlaybackSample | undefined {
    const i = Math.floor(this.position);
    const prev = this.source.snapshot(i);
    if (!prev) return undefined;
    const alpha = this.position - i;
    // On a whole tick draw exactly that tick: the renderer draws the snakes of `next`, so a
    // snake that dies on the following tick would vanish from its own last frame.
    const next = alpha > 0 ? this.source.snapshot(i + 1) : undefined;
    if (!next) return { prev, next: prev, alpha: 0 };
    return { prev, next, alpha };
  }

  /** Snapshot of `tick`. */
  current(): TickSnapshot | undefined {
    return this.source.snapshot(this.tick);
  }

  /**
   * Keeps `tick` inside what the source can show. Interpolation needs the tick after the
   * playhead, so when `request` is set that one is asked for too.
   */
  private clamp(tick: number, request: boolean): number {
    const s = this.source;
    const end = s.endTick;
    const wanted = end === undefined ? tick : Math.min(tick, end);
    if (request && wanted > s.lastTick - 1) {
      const ahead = Math.ceil(wanted) + (Number.isInteger(wanted) ? 1 : 0);
      s.request(end === undefined ? ahead : Math.min(ahead, end));
    }
    // Without the next tick there is nothing to blend towards, so stop on the last one.
    return Math.max(s.firstTick, Math.min(wanted, s.lastTick));
  }
}
