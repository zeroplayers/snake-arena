/**
 * Life traces (#25, format in apps/web `src/shared/trace.ts`): one `TraceRecorder` per real life
 * in the room. `RoomSim` feeds it every tick the world stepped; the room saves every recorder's
 * state with the batch (so a reload loses nothing) and, when the life ends, queues the finished
 * trace for R2 `TRACES` in the same transaction as the life's row.
 *
 * Bounded by construction: the last `TRACE_FULL_TICKS` ticks, at most `TRACE_SAMPLED_MAX`
 * downsampled ones and `TRACE_EVENTS_MAX` events, logs at most 1 KB per tick (the sandbox's limit)
 * and escaped at most 2× in JSON (control characters are replaced). `finish` enforces
 * `TRACE_MAX_BYTES` on top.
 */
import type { BotLife, TickReport } from "@zerosnake/sandbox";
import type { BotState } from "@zerosnake/sdk";
import {
  type LifeTrace,
  TRACE_ERROR_BYTES,
  TRACE_EVENTS_MAX,
  TRACE_FORMAT,
  TRACE_FULL_TICKS,
  TRACE_MAX_BYTES,
  TRACE_RESTARTS_MAX,
  TRACE_SAMPLED_LOG_BYTES,
  TRACE_SAMPLED_MAX,
  type TraceSeen,
  type TraceTick,
  type TraceTotals,
  utf8Bytes,
} from "@zerosnake/web/shared";

/** What the room keeps of a recorder between batches (plain JSON). */
export type TraceState = Omit<LifeTrace, "format" | "endTick" | "cause" | "killer" | "trimmed">;

export interface TraceStart {
  lifeId: string;
  versionId: string;
  roomId: string;
  startTick: number;
  budget: LifeTrace["budget"];
}

const encoder = new TextEncoder();

export class TraceRecorder {
  constructor(readonly state: TraceState) {}

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
    const recorder = new TraceRecorder({
      ...start,
      totals,
      load: { log: [] },
      restarts: [],
      sampleEvery: 1,
      sampled: [],
      events: [],
      full: [],
    });
    recorder.loaded(life);
    return recorder;
  }

  /**
   * The bot started again on room tick `tick` (the room reloaded): new memory, same snake. Keeps
   * the first life start's load log unless that one had none.
   */
  restart(tick: number, life: BotLife): void {
    const restarts = this.state.restarts;
    restarts.push(tick);
    if (restarts.length > TRACE_RESTARTS_MAX) restarts.shift();
    if (this.state.load.log.length === 0 && !this.state.load.error) this.loaded(life);
  }

  /** One bot call, after the world stepped past it. */
  record(seen: BotState, report: TickReport): void {
    const s = this.state;
    const totals = s.totals;
    const log = report.log.lines.map(clean);
    const logBytes = log.reduce((n, line) => n + utf8Bytes(line), 0);
    totals.ticks++;
    if (report.outcome === "timeout") totals.timeouts++;
    else if (report.outcome === "error") totals.errors++;
    else if (report.outcome === "skipped") totals.skipped++;
    totals.maxWork = Math.max(totals.maxWork, report.work);
    totals.sumWork += report.work;
    totals.maxOps = Math.max(totals.maxOps, report.interrupts);
    if (logBytes > 0) totals.logTicks++;
    totals.logBytes += logBytes;

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
    if (report.error) tick.error = cut(clean(report.error), TRACE_ERROR_BYTES);
    if (report.log.truncated) tick.logCut = true;
    s.full.push(tick);
    if (s.full.length > TRACE_FULL_TICKS) this.retire(s.full.shift() as TraceTick);
  }

  /** The finished trace's JSON, at most `TRACE_MAX_BYTES`. */
  finish(end: { endTick: number; cause: string; killer: string | null }): Uint8Array {
    const trace: LifeTrace = { format: TRACE_FORMAT, ...this.state, ...end };
    let bytes = encoder.encode(JSON.stringify(trace));
    // Can't happen within the per-tick log limit; if it ever does, the oldest logs go first.
    for (let i = 0; bytes.length > TRACE_MAX_BYTES && i < trace.full.length; i++) {
      trace.trimmed = true;
      trace.full[i] = { ...(trace.full[i] as TraceTick), log: [], logCut: true };
      bytes = encoder.encode(JSON.stringify(trace));
    }
    return bytes;
  }

  private loaded(life: BotLife): void {
    this.state.load = {
      log: life.loadLog.lines.map(clean),
      ...(life.death && { error: cut(clean(life.death.message), TRACE_ERROR_BYTES) }),
    };
  }

  /** A tick leaving the full window: downsampled, kept as an event, or dropped. */
  private retire(tick: TraceTick): void {
    const s = this.state;
    if (tick.lifeTick % s.sampleEvery === 0) {
      s.sampled.push(shrink(tick));
      if (s.sampled.length > TRACE_SAMPLED_MAX) {
        s.sampleEvery *= 2;
        const kept: TraceTick[] = [];
        for (const t of s.sampled) {
          if (t.lifeTick % s.sampleEvery === 0) kept.push(t);
          else if (t.outcome !== "ok") this.event(t);
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
    if (events.length > TRACE_EVENTS_MAX) events.shift();
  }
}

/** A downsampled tick: logs and error cut to `TRACE_SAMPLED_LOG_BYTES`. */
function shrink(tick: TraceTick): TraceTick {
  let budget = TRACE_SAMPLED_LOG_BYTES;
  const log: string[] = [];
  let logCut = tick.logCut === true;
  for (const line of tick.log) {
    if (budget <= 0) {
      logCut = true;
      break;
    }
    const kept = cut(line, budget);
    if (kept.length < line.length) logCut = true;
    log.push(kept);
    budget -= utf8Bytes(kept);
  }
  const { logCut: _, ...rest } = tick;
  return {
    ...rest,
    log,
    ...(logCut && { logCut: true as const }),
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

/**
 * Control characters other than tab become `?`: JSON escapes them as six bytes each, which would
 * make a trace's size depend on what the bot logs instead of how much.
 */
function clean(s: string): string {
  return s.replace(/[^\t\x20-￿]/g, "?");
}

/** The longest prefix of `s` of at most `bytes` UTF-8 bytes (whole code points). */
function cut(s: string, bytes: number): string {
  if (utf8Bytes(s) <= bytes) return s;
  let n = 0;
  let i = 0;
  for (const ch of s) {
    const size = utf8Bytes(ch);
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
