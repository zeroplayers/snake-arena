/**
 * The room's CPU backstop: deciding what a batch that died means, and how long to watch the room
 * afterwards. Pure functions over wall-clock numbers, so every rule is unit-tested.
 *
 * The only evidence a Worker has is wall-clock time at I/O: the clock is frozen during CPU work,
 * but CPU time never exceeds wall time. So a batch killed by the CPU limit left its marker at least
 * `cpuLimitMs` before the next invocation looked at it. Anything quicker was a restart (deploy,
 * eviction, runtime update) and blames nobody.
 *
 * Watch mode ("isolated running", not a replay: bots run forward and keep their memory) syncs
 * "who is about to run" and the time to storage before every bot call, and stops a batch early
 * once `WATCH_STOP_SHARE` of the limit has passed. So in watch mode the invocation can only die
 * inside one bot call that by itself ran for most of the CPU limit, and every bot call has a
 * measured upper bound on its CPU.
 */

/** A marker older than this share of the CPU limit is consistent with a CPU kill (clock skew). */
export const CPU_EVIDENCE = 0.9;
/** Watch mode ends a batch between ticks after this share of the CPU limit (wall time). */
export const WATCH_STOP_SHARE = 0.3;
/** …and abandons the tick in progress after this share (only aggregate overload gets there). */
export const WATCH_ABORT_SHARE = 0.6;
/** Watch length after the first CPU incident in a day (one minute of game time). */
export const WATCH_TICKS = 600;
/** CPU incidents within this window escalate the watch. */
export const INCIDENT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A bot call measured over this in watch mode counts as a slow tick (27 ms is the worst budget). */
export const DEFAULT_SLOW_TICK_MS = 250;
/** Slow ticks in one life before the snake dies by `timeout`. */
export const SLOW_TICKS_TO_KILL = 3;
/** Strikes (CPU culprit verdicts or slow kills) of one version before it is banned. */
export const STRIKES_TO_BAN = 2;

/** What `RoomStore` keeps of a batch in progress, as far as the backstop is concerned. */
export interface CrashMarker {
  /** Wall ms when the batch started (written before the batch's code ran). */
  startedAt: number;
  watch: boolean;
  /** Watch mode: the life whose code was about to run, and the wall ms it was written at. */
  suspectLife: string | null;
  suspectAt: number | null;
}

export type Verdict =
  /** Too quick to be the CPU limit: a restart. Nobody is blamed; the batch runs again. */
  | { kind: "restart"; gapMs: number }
  /** Possibly the CPU limit, with no single bot to blame (normal mode, or between bots). */
  | { kind: "overrun"; gapMs: number }
  /** Watch mode, and only the suspect's own call can have used that much CPU. */
  | { kind: "culprit"; lifeId: string; gapMs: number; callMs: number };

export function judgeCrash(marker: CrashMarker, now: number, cpuLimitMs: number): Verdict {
  const gapMs = now - marker.startedAt;
  if (gapMs < CPU_EVIDENCE * cpuLimitMs) return { kind: "restart", gapMs };
  if (!marker.watch || marker.suspectLife === null || marker.suspectAt === null) {
    return { kind: "overrun", gapMs };
  }
  // Everything before the suspect's call used at most `before` of CPU, so a CPU kill inside its
  // call means the call alone used at least `limit - before`; and that much wall time must have
  // passed since. Watch mode stops before `before` gets near the limit.
  const before = marker.suspectAt - marker.startedAt;
  const callMs = now - marker.suspectAt;
  const needed = cpuLimitMs - before;
  if (before <= WATCH_ABORT_SHARE * cpuLimitMs && callMs >= CPU_EVIDENCE * needed) {
    return { kind: "culprit", lifeId: marker.suspectLife, gapMs, callMs };
  }
  return { kind: "overrun", gapMs };
}

export interface WatchWindow {
  /** Watch until the world reaches this tick… */
  untilTick: number;
  /** …and until this wall ms. */
  untilMs: number;
}

/**
 * How long to watch after a CPU incident, given how many there were in the last
 * `INCIDENT_WINDOW_MS` (this one included): a minute of game time for the first, a full life
 * (`lifeCap`, so every life in the room starts and ends under watch) for the second, and a day of
 * wall time from the third on. Never shortens a watch already running.
 */
export function watchWindow(
  current: WatchWindow,
  recentIncidents: number,
  tick: number,
  now: number,
  lifeCap: number,
): WatchWindow {
  const next =
    recentIncidents <= 1
      ? { untilTick: tick + WATCH_TICKS, untilMs: 0 }
      : recentIncidents === 2
        ? { untilTick: tick + lifeCap, untilMs: 0 }
        : { untilTick: tick + lifeCap, untilMs: now + INCIDENT_WINDOW_MS };
  return {
    untilTick: Math.max(current.untilTick, next.untilTick),
    untilMs: Math.max(current.untilMs, next.untilMs),
  };
}

export function watching(w: WatchWindow, tick: number, now: number): boolean {
  return tick < w.untilTick || now < w.untilMs;
}

/** Delay before retrying an outbox item after `attempts` failures: 1 s, 2 s, 4 s… up to 10 min. */
export function retryDelayMs(attempts: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempts - 1), 10 * 60 * 1000);
}
