/**
 * A room's `room.batch` metric (`@zerosnake/observability`): batches add to sums kept in memory,
 * written as one data point at most every `RoomLimits.metricsMs`, so a room in accelerated mode
 * (many short batches a second) costs a write per period, not per batch, and never one per tick.
 * What an eviction or crash loses is at most one period of a room's counts.
 */
import { type MetricsDataset, writeMetric } from "@zerosnake/observability";
import type { RoomMode } from "../protocol.ts";

export interface BatchSample {
  ticks: number;
  botTicks: number;
  workUnits: number;
  livesStarted: number;
  livesEnded: number;
  /** House snakes retired to make way for real lives. */
  houseRetired: number;
  /** The simulation's wall time, first bot call to saved result (none of the I/O around it). */
  wallMs: number;
  watched: boolean;
  /** Watch mode ended the batch early (a tick abandoned, or a call named). */
  cut: boolean;
}

/** What the room is now, at the write. */
export interface RoomNow {
  roomId: string;
  mode: RoomMode;
  snakes: number;
  spectators: number;
  tick: number;
  /** Snakes of deployed versions (the rest are house bots). */
  realLives: number;
}

export class BatchMetrics {
  private sums = emptySums();
  /** Wall ms the sums started (the room loaded, or the last write). */
  private since: number;

  constructor(now: number) {
    this.since = now;
  }

  add(b: BatchSample): void {
    const s = this.sums;
    s.batches++;
    s.ticks += b.ticks;
    s.botTicks += b.botTicks;
    s.workUnits += b.workUnits;
    s.livesStarted += b.livesStarted;
    s.livesEnded += b.livesEnded;
    s.houseRetired += b.houseRetired;
    s.wallMs += b.wallMs;
    s.maxWallMs = Math.max(s.maxWallMs, b.wallMs);
    if (b.watched) s.watched++;
    if (b.cut) s.cut++;
  }

  /** Writes the sums if `everyMs` passed since the last write (or `force`), and starts afresh. */
  flush(
    dataset: MetricsDataset | undefined,
    room: RoomNow,
    now: number,
    everyMs: number,
    force = false,
  ): boolean {
    if (this.sums.batches === 0 || (!force && now - this.since < everyMs)) return false;
    writeMetric(dataset, "room.batch", { ...room, ...this.sums, periodMs: now - this.since });
    this.sums = emptySums();
    this.since = now;
    return true;
  }
}

function emptySums() {
  return {
    batches: 0,
    ticks: 0,
    botTicks: 0,
    workUnits: 0,
    livesStarted: 0,
    livesEnded: 0,
    houseRetired: 0,
    wallMs: 0,
    maxWallMs: 0,
    watched: 0,
    cut: 0,
  };
}
