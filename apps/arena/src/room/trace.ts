/**
 * Life traces (#25, format in apps/web `src/shared/trace.ts`): one `TraceRecorder` per real life
 * in the room. `RoomSim` feeds it every tick the world stepped; the room saves what changed with
 * each batch (`changes`, rows in `trace-store.ts`, so a reload loses nothing) and, when the life
 * ends, queues the finished trace for R2 `TRACES` in the same transaction as the life's row.
 *
 * Bounded by construction, in JSON bytes: the last `TRACE_FULL_TICKS` ticks with at most
 * `TRACE_TICK_LOG_BYTES` of logs each, at most `TRACE_SAMPLED_MAX` downsampled ticks and
 * `TRACE_EVENTS_MAX` events with `TRACE_SAMPLED_LOG_BYTES` each (lines are charged their escapes
 * and `TRACE_LINE_OVERHEAD`, so many short lines cost what they take). `finish` enforces
 * `TRACE_MAX_BYTES` on top.
 */
import type { BotLife, TickReport } from "@zerosnake/sandbox";
import type { BotState } from "@zerosnake/sdk";
import {
  jsonBytes,
  type LifeTrace,
  printable,
  TRACE_ERROR_BYTES,
  TRACE_EVENTS_MAX,
  TRACE_FORMAT,
  TRACE_FULL_TICKS,
  TRACE_LINE_OVERHEAD,
  TRACE_MAX_BYTES,
  TRACE_RESTARTS_MAX,
  TRACE_SAMPLED_LOG_BYTES,
  TRACE_SAMPLED_MAX,
  TRACE_TICK_LOG_BYTES,
  type TraceSeen,
  type TraceTick,
  type TraceTotals,
  utf8Bytes,
} from "@zerosnake/web/shared";

/** What the room keeps of a recorder between batches (plain JSON). */
export type TraceState = Omit<LifeTrace, "format" | "endTick" | "cause" | "killer" | "trimmed">;

/**
 * A saved row of a recorder: its head (everything but the load log and the ticks), its load log,
 * or one kept tick (`tick` is the room tick; 0 for the other two).
 */
export type TraceRowKind = "head" | "load" | "full" | "sampled" | "event";
export interface TraceRow {
  kind: TraceRowKind;
  tick: number;
  json: string;
}
/** A row to write, or (`json` null) to delete. */
export interface TraceChange {
  kind: TraceRowKind;
  tick: number;
  json: string | null;
}

const TICK_KINDS = { full: "full", sampled: "sampled", events: "event" } as const;
type TickKind = (typeof TICK_KINDS)[keyof typeof TICK_KINDS];

export interface TraceStart {
  lifeId: string;
  versionId: string;
  roomId: string;
  startTick: number;
  budget: LifeTrace["budget"];
}

const encoder = new TextEncoder();

export class TraceRecorder {
  /** Tick rows in storage (`kind:tick`). */
  private readonly saved = new Set<string>();
  /** Tick rows changed since the last `changes()`: the tick to write, or null to delete. */
  private readonly pending = new Map<
    string,
    { kind: TickKind; tick: number; value: TraceTick | null }
  >();
  private headChanged: boolean;
  private loadChanged: boolean;

  /** `state` as saved (all of it is in storage), or, with `saved` false, not saved at all. */
  constructor(
    readonly state: TraceState,
    saved = true,
  ) {
    this.headChanged = this.loadChanged = !saved;
    if (!saved) return;
    for (const [field, kind] of Object.entries(TICK_KINDS)) {
      for (const t of state[field as keyof typeof TICK_KINDS]) this.saved.add(`${kind}:${t.tick}`);
    }
  }

  /** A new life: its first bot start (`init`) just happened. */
  static start(start: TraceStart, life: BotLife): TraceRecorder {
    const totals: TraceTotals = {
      ticks: 0,
      timeouts: 0,
      errors: 0,
      skipped: 0,
      maxWork: 0,
      sumWork: 0,
      maxOps: 0,
      logTicks: 0,
      logBytes: 0,
    };
    const recorder = new TraceRecorder(
      {
        ...start,
        totals,
        load: { log: [] },
        restarts: [],
        sampleEvery: 1,
        sampled: [],
        events: [],
        full: [],
      },
      false,
    );
    recorder.loaded(life);
    return recorder;
  }

  /** A recorder from its saved rows (`changes`), or null without a head row. */
  static fromRows(rows: readonly TraceRow[]): TraceRecorder | null {
    let head: Omit<TraceState, "load" | "sampled" | "events" | "full"> | null = null;
    const state = { load: { log: [] }, sampled: [], events: [], full: [] } as Pick<
      TraceState,
      "load" | "sampled" | "events" | "full"
    >;
    for (const row of rows) {
      const value = JSON.parse(row.json);
      if (row.kind === "head") head = value;
      else if (row.kind === "load") state.load = value;
      else state[row.kind === "event" ? "events" : row.kind].push(value);
    }
    if (!head) return null;
    for (const ticks of [state.sampled, state.events, state.full])
      ticks.sort((a, b) => a.tick - b.tick);
    return new TraceRecorder({ ...head, ...state });
  }

  /**
   * The bot started again on room tick `tick` (the room reloaded): new memory, same snake. Keeps
   * the first life start's load log unless that one had none.
   */
  restart(tick: number, life: BotLife): void {
    const restarts = this.state.restarts;
    restarts.push(tick);
    if (restarts.length > TRACE_RESTARTS_MAX) restarts.shift();
    this.headChanged = true;
    if (this.state.load.log.length === 0 && !this.state.load.error) this.loaded(life);
  }

  /** One bot call, after the world stepped past it. */
  record(seen: BotState, report: TickReport): void {
    const s = this.state;
    const totals = s.totals;
    const logBytes = report.log.lines.reduce((n, line) => n + utf8Bytes(line), 0);
    const { log, cut: logCut } = keepLog(report.log.lines.map(printable), TRACE_TICK_LOG_BYTES);
    totals.ticks++;
    if (report.outcome === "timeout") totals.timeouts++;
    else if (report.outcome === "error") totals.errors++;
    else if (report.outcome === "skipped") totals.skipped++;
    totals.maxWork = Math.max(totals.maxWork, report.work);
    totals.sumWork += report.work;
    totals.maxOps = Math.max(totals.maxOps, report.interrupts);
    if (logBytes > 0) totals.logTicks++;
    totals.logBytes += logBytes;
    this.headChanged = true;

    const tick: TraceTick = {
      tick: seen.tick,
      lifeTick: seen.lifeTick,
      turn: round(report.action.turn, 1000),
      boost: report.action.boost === true,
      outcome: report.outcome,
      work: report.work,
      ops: report.interrupts,
      log,
      seen: summarize(seen),
    };
    if (report.error) tick.error = cut(printable(report.error), TRACE_ERROR_BYTES);
    if (report.log.truncated || logCut) tick.logCut = true;
    s.full.push(tick);
    this.add("full", tick);
    if (s.full.length > TRACE_FULL_TICKS) {
      const old = s.full.shift() as TraceTick;
      this.remove("full", old);
      this.retire(old);
    }
  }

  /**
   * The rows that changed since the last call, for the room to save with the batch: the head
   * (totals change every tick), the load log if it changed, and the ticks that entered or left
   * the trace. A tick that came and went between two calls is never written.
   */
  changes(): TraceChange[] {
    const out: TraceChange[] = [];
    if (this.headChanged) {
      const { load: _, sampled: _s, events: _e, full: _f, ...head } = this.state;
      out.push({ kind: "head", tick: 0, json: JSON.stringify(head) });
    }
    if (this.loadChanged)
      out.push({ kind: "load", tick: 0, json: JSON.stringify(this.state.load) });
    for (const [key, { kind, tick, value }] of this.pending) {
      out.push({ kind, tick, json: value && JSON.stringify(value) });
      if (value) this.saved.add(key);
      else this.saved.delete(key);
    }
    this.pending.clear();
    this.headChanged = this.loadChanged = false;
    return out;
  }

  /**
   * The finished trace's JSON, at most `TRACE_MAX_BYTES`. Can't be over within the bounds above;
   * if it ever is, logs go from the least useful ticks first: events, downsampled ones (oldest
   * first), and only then the full window's, oldest first.
   */
  finish(end: { endTick: number; cause: string; killer: string | null }): Uint8Array {
    const trace: LifeTrace = { format: TRACE_FORMAT, ...this.state, ...end };
    let bytes = encoder.encode(JSON.stringify(trace));
    let over = bytes.length - TRACE_MAX_BYTES;
    if (over <= 0) return bytes;
    trace.trimmed = true;
    over += utf8Bytes(',"trimmed":true');
    for (const ticks of [trace.events, trace.sampled, trace.full]) {
      for (let i = 0; over > 0 && i < ticks.length; i++) {
        const tick = ticks[i] as TraceTick;
        if (tick.log.length === 0) continue;
        const trimmed: TraceTick = { ...tick, log: [], logCut: true };
        over -= utf8Bytes(JSON.stringify(tick)) - utf8Bytes(JSON.stringify(trimmed));
        ticks[i] = trimmed;
      }
    }
    bytes = encoder.encode(JSON.stringify(trace));
    return bytes;
  }

  private loaded(life: BotLife): void {
    const { log, cut: logCut } = keepLog(life.loadLog.lines.map(printable), TRACE_TICK_LOG_BYTES);
    this.state.load = {
      log,
      ...((life.loadLog.truncated || logCut) && { logCut: true as const }),
      ...(life.death && { error: cut(printable(life.death.message), TRACE_ERROR_BYTES) }),
    };
    this.loadChanged = true;
  }

  /** A tick leaving the full window: downsampled, kept as an event, or dropped. */
  private retire(tick: TraceTick): void {
    const s = this.state;
    if (tick.lifeTick % s.sampleEvery === 0) {
      const shrunk = shrink(tick);
      s.sampled.push(shrunk);
      this.add("sampled", shrunk);
      if (s.sampled.length > TRACE_SAMPLED_MAX) {
        s.sampleEvery *= 2;
        this.headChanged = true;
        const kept: TraceTick[] = [];
        for (const t of s.sampled) {
          if (t.lifeTick % s.sampleEvery === 0) {
            kept.push(t);
            continue;
          }
          this.remove("sampled", t);
          if (t.outcome !== "ok") this.event(t);
        }
        s.sampled = kept;
      }
    } else if (tick.outcome !== "ok") {
      this.event(shrink(tick));
    }
  }

  private event(tick: TraceTick): void {
    const events = this.state.events;
    let i = events.length;
    while (i > 0 && (events[i - 1] as TraceTick).tick > tick.tick) i--;
    events.splice(i, 0, tick);
    this.add("event", tick);
    if (events.length > TRACE_EVENTS_MAX) this.remove("event", events.shift() as TraceTick);
  }

  private add(kind: TickKind, tick: TraceTick): void {
    this.pending.set(`${kind}:${tick.tick}`, { kind, tick: tick.tick, value: tick });
  }

  private remove(kind: TickKind, tick: TraceTick): void {
    const key = `${kind}:${tick.tick}`;
    if (this.saved.has(key)) this.pending.set(key, { kind, tick: tick.tick, value: null });
    else this.pending.delete(key);
  }
}

/**
 * The lines of `lines` that fit `budget` JSON bytes (each line charged its escaped bytes and
 * `TRACE_LINE_OVERHEAD`), the first one that doesn't cut to fit; `cut` if anything was left out.
 */
function keepLog(lines: readonly string[], budget: number): { log: string[]; cut: boolean } {
  const log: string[] = [];
  for (const line of lines) {
    const room = budget - TRACE_LINE_OVERHEAD;
    if (room < 0) return { log, cut: true };
    const size = jsonBytes(line);
    if (size > room) {
      if (room > 0) log.push(cut(line, room));
      return { log, cut: true };
    }
    log.push(line);
    budget = room - size;
  }
  return { log, cut: false };
}

/** A downsampled tick: logs and error cut to `TRACE_SAMPLED_LOG_BYTES`. */
function shrink(tick: TraceTick): TraceTick {
  const { log, cut: logCut } = keepLog(tick.log, TRACE_SAMPLED_LOG_BYTES);
  const { logCut: _, ...rest } = tick;
  return {
    ...rest,
    log,
    ...((logCut || tick.logCut) && { logCut: true as const }),
    ...(tick.error !== undefined && { error: cut(tick.error, TRACE_SAMPLED_LOG_BYTES) }),
  };
}

/** What the bot saw, in a few numbers. */
export function summarize(state: BotState): TraceSeen {
  const self = state.self;
  const { x, y } = self.head;
  let nearest: TraceSeen["nearest"] = null;
  for (const snake of state.snakes) {
    let best = Number.POSITIVE_INFINITY;
    for (const p of snake.segments) best = Math.min(best, Math.hypot(p.x - x, p.y - y));
    const gap = best - self.radius - snake.radius;
    if (nearest === null || gap < nearest.gap) {
      nearest = {
        id: snake.id,
        author: snake.author,
        gap,
        length: Math.round(snake.length),
        head: snake.head !== null,
      };
    }
  }
  if (nearest) nearest.gap = round(nearest.gap, 100);
  let foodDist: number | null = null;
  for (const f of state.food) {
    const d = Math.hypot(f.x - x, f.y - y);
    if (foodDist === null || d < foodDist) foodDist = d;
  }
  return {
    x: round(x, 10),
    y: round(y, 10),
    angle: round(self.angle, 100),
    length: Math.round(self.length),
    wall: round(state.wallDistance, 10),
    snakes: state.snakes.length,
    food: state.food.length,
    nearest,
    foodDist: foodDist === null ? null : round(foodDist, 10),
  };
}

function round(n: number, scale: number): number {
  return Number.isFinite(n) ? Math.round(n * scale) / scale : 0;
}

/** The longest prefix of `s` of at most `bytes` JSON bytes (`jsonBytes`; whole code points). */
function cut(s: string, bytes: number): string {
  if (jsonBytes(s) <= bytes) return s;
  let n = 0;
  let i = 0;
  for (const ch of s) {
    const size = jsonBytes(ch);
    if (n + size > bytes) break;
    n += size;
    i += ch.length;
  }
  return s.slice(0, i);
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
