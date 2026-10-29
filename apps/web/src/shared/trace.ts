/**
 * Life traces (SPEC §7, #25): what a bot saw, returned, spent and logged, tick by tick, so its
 * author can see why it died. The room records one per real life (house bots get none) and writes
 * it to R2 `TRACES` when the life ends; `lives.trace_key` points at it.
 *
 * - The last {@link TRACE_FULL_TICKS} ticks before the end are kept exactly (`full`).
 * - Older ticks are downsampled (`sampled`): every `sampleEvery`-th life tick, the stride doubling
 *   whenever more than {@link TRACE_SAMPLED_MAX} would be kept, with logs cut to
 *   {@link TRACE_SAMPLED_LOG_BYTES}. The last {@link TRACE_EVENTS_MAX} older ticks that timed out
 *   or threw are kept too (`events`), and `totals` count every tick of the life.
 * - A trace is at most {@link TRACE_MAX_BYTES} of JSON (gzip in R2), whatever the bot logs.
 * - Kept {@link TRACE_RETENTION_DAYS} days: an R2 lifecycle rule on the bucket, and the arena's
 *   cron deletes older days too (keys start with the UTC day the life ended).
 *
 * Who can read one: only the owner of the bot (CLI token or browser session). Traces hold the
 * author's own `log()` output, which may describe a strategy the author hasn't published; sources
 * are public, logs aren't.
 */

import type { LifeEnding } from "./lives";

export const TRACE_FORMAT = 1;
/** Ticks before the end kept exactly. */
export const TRACE_FULL_TICKS = 100;
/** Most downsampled ticks kept from before the full window. */
export const TRACE_SAMPLED_MAX = 200;
/**
 * Log sizes below are JSON bytes, as the trace stores them: each line's UTF-8 bytes, plus one per
 * `"`, `\` or tab (escaped), plus {@link TRACE_LINE_OVERHEAD}. Counting the overhead matters: the
 * sandbox charges an empty line one byte, so 1 KB of `log("")` is 1024 lines, ~3 KB of JSON.
 */
export const TRACE_LINE_OVERHEAD = 3;
/**
 * JSON bytes of `log()` output kept per exactly kept tick (and of the load log): the sandbox's
 * 1 KB per tick always fits, even all escaped, unless it's split into many short lines.
 */
export const TRACE_TICK_LOG_BYTES = 2304;
/** JSON bytes of `log()` output (and of the error) kept per downsampled tick. */
export const TRACE_SAMPLED_LOG_BYTES = 160;
/** Most timeouts and errors kept from before the full window. */
export const TRACE_EVENTS_MAX = 20;
/** Room ticks the bot restarted on (the room reloaded) that are kept. */
export const TRACE_RESTARTS_MAX = 20;
/** JSON bytes of an error message kept. */
export const TRACE_ERROR_BYTES = 300;
/**
 * Upper bound of a trace's JSON. Every part is bounded in JSON bytes, whatever the bot logs: a
 * worst-case trace (every tick filling its log budget with characters JSON escapes, or with
 * thousands of empty lines, and failing) is about 445 KB; apps/arena's `room/trace.test.ts` builds
 * them. Enforced anyway (oldest downsampled logs go first). A 6000-tick life logging a short line
 * every other tick is about 90 KB (10 KB gzipped, as stored), and a 24-hour one (the life cap) no
 * bigger: its older ticks are downsampled to at most `TRACE_SAMPLED_MAX`, the stride doubling as
 * it goes (to every 8192nd tick over a day), and the last `TRACE_FULL_TICKS` before the end stay
 * exact.
 */
export const TRACE_MAX_BYTES = 512 * 1024;
export const TRACE_RETENTION_DAYS = 7;

/** A summary of the `BotState` the bot got: enough to tell what it was up against. */
export interface TraceSeen {
  /** Head position and heading (radians), rounded. */
  x: number;
  y: number;
  angle: number;
  length: number;
  /** Distance from the head to the arena edge. */
  wall: number;
  /** Snakes and food in vision. */
  snakes: number;
  food: number;
  /**
   * The snake whose visible body comes closest to the head: gap between the two bodies (negative
   * when touching), its length and whether its head is in vision.
   */
  nearest: { id: string; author: string; gap: number; length: number; head: boolean } | null;
  /** Distance to the closest food, or null if none is visible. */
  foodDist: number | null;
}

export type TraceOutcome = "ok" | "timeout" | "error" | "skipped";

/** One bot call: what it saw on room tick `tick` and what it did about it. */
export interface TraceTick {
  tick: number;
  lifeTick: number;
  /** The action applied: on a timeout or error, the previous one. */
  turn: number;
  boost: boolean;
  outcome: TraceOutcome;
  error?: string;
  /** Cost units charged (budget: `budget.work`) and interrupt-handler calls (`budget.ops`). */
  work: number;
  ops: number;
  log: string[];
  /** Some `log()` output was cut: by the sandbox's per-tick limit, or by downsampling. */
  logCut?: true;
  seen: TraceSeen;
}

export interface TraceTotals {
  /** Bot calls in the whole life. */
  ticks: number;
  timeouts: number;
  errors: number;
  skipped: number;
  maxWork: number;
  sumWork: number;
  maxOps: number;
  /** Ticks with any `log()` output, and its total bytes. */
  logTicks: number;
  logBytes: number;
}

export interface LifeTrace {
  format: typeof TRACE_FORMAT;
  lifeId: string;
  versionId: string;
  roomId: string;
  startTick: number;
  endTick: number;
  /** How the life ended, as in `lives.death_cause` (plus `evicted`). */
  cause: string;
  /** Who it ran into: a version id, `house:<kind>`, or null. */
  killer: string | null;
  /** Per-tick limits the bot ran under. */
  budget: { ops: number; work: number; logBytes: number };
  totals: TraceTotals;
  /** `log()` output of loading the bundle and `init()`, and the error if that failed. */
  load: { log: string[]; logCut?: true; error?: string };
  /**
   * Room ticks on which the room reloaded and the bot started again (`init`, empty memory). The
   * world carried on; only the bot's memory was lost.
   */
  restarts: number[];
  /** Stride of `sampled`, in life ticks. */
  sampleEvery: number;
  sampled: TraceTick[];
  /** Older ticks that timed out or threw (not already in `sampled`). */
  events: TraceTick[];
  /** The last {@link TRACE_FULL_TICKS} ticks, oldest first. */
  full: TraceTick[];
  /** Set when the size cap cut log text from older ticks (should never happen). */
  trimmed?: true;
}

/**
 * R2 key of a life's trace: the UTC day it ended first, so retention can delete whole days.
 */
export function traceKey(lifeId: string, endedAt: number): string {
  return `${new Date(endedAt).toISOString().slice(0, 10)}/${lifeId}.json.gz`;
}

/**
 * `s` safe to store and print: control characters other than tab (C0, DEL, C1, which includes the
 * one-byte CSI), bidi overrides and isolates, line separators and lone surrogates become `?`. The
 * room stores logs this way (JSON would escape control characters as six bytes each, making a
 * trace's size depend on what the bot logs instead of how much); the CLI applies it again before
 * printing, so a terminal never gets an escape sequence from a trace.
 */
export function printable(s: string): string {
  return s.replace(UNPRINTABLE, "?");
}

const UNPRINTABLE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
  /[\0-\x08\x0a-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ud800-\udfff]/gu;

/** JSON bytes of a `printable` string (quotes excluded): `"`, `\` and tab are escaped. */
export function jsonBytes(s: string): number {
  let n = utf8Bytes(s);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22 || c === 0x5c || c === 0x09) n++;
  }
  return n;
}

/** UTF-8 bytes of `s`. */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/** All ticks of a trace, oldest first (sampled and events merged by tick, then full). */
export function traceTicks(trace: LifeTrace): TraceTick[] {
  const older = [...trace.sampled, ...trace.events].sort((a, b) => a.tick - b.tick);
  return [...older, ...trace.full];
}

// ─── API ─────────────────────────────────────────────────────────────────────────────────────────

/** `GET /api/lives/:id/trace` (CLI token; the bot's owner only): the trace, killer named. */
export interface TraceResponse extends LifeTrace {
  /** `@user/bot v3`, `house bot hard`, or null. */
  killerName: string | null;
  /**
   * Whether `/replay/<lifeId>` still plays (replays are kept 2 days, `src/shared/replay.ts`).
   * Missing from servers before #78.
   */
  hasReplay?: boolean;
}

/** One life, as `GET /api/bots/:bot/versions/:n/lives` returns it (latest first). */
export interface LifeSummary {
  id: string;
  /** ISO 8601. */
  startedAt: string;
  endedAt: string | null;
  score: number;
  lengthMax: number;
  kills: number;
  deathCause: "collision" | "wall" | "timeout" | "error" | "retired" | null;
  /**
   * How it ended: `deathCause` with `retired` split into `capped` (reached the life cap) and
   * `stopped` (its version stopped playing), `src/shared/lives.ts`. Missing from servers before
   * long lives.
   */
  ending?: LifeEnding | null;
  /** Ticks alive; `null` while alive. Missing from servers before long lives. */
  ticks?: number | null;
  /** Who it ran into, for people: `@user/bot v3` or `house bot hard`. */
  killer: string | null;
  /** Whether a trace was recorded (it may have expired since: 7 days). */
  hasTrace: boolean;
  /**
   * Whether `/replay/<id>` still plays (replays are kept 2 days, `src/shared/replay.ts`).
   * Missing from servers before #78.
   */
  hasReplay?: boolean;
}

export interface LivesResponse {
  lives: LifeSummary[];
}

export const LIVES_LIMIT_MAX = 100;
