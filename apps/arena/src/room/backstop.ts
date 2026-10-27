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
 *
 * Timing alone still can't tell a CPU kill from a restart with a slow recovery, and most of watch
 * mode's wall time is storage syncs during which the last bot stays the recorded suspect. So a
 * watched crash (or a bot measured slow) only names a **suspect**. The suspect is then put on
 * **trial**: in an invocation of its own, only its code runs, in a fresh sandbox, on a throwaway
 * copy of the saved world (other snakes go straight). A strike needs the trial to reproduce the
 * overrun: die with CPU-limit evidence twice at the same tick, or measure slow on its own. A trial
 * that completes clears the suspect. Restarts land at random; a real overrun reproduces.
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
/** Slow calls of one life in watch mode before it is put on (slow) trial. */
export const SLOW_TICKS_TO_SUSPECT = 3;
/** Strikes (confirmed by trial) of one version before it is banned. */
export const STRIKES_TO_BAN = 2;
/** A CPU trial runs the suspect this many ticks past the tick it was suspected at. */
export const TRIAL_MARGIN_TICKS = 5;
/** A slow trial runs the suspect alone for this many ticks… */
export const SLOW_TRIAL_TICKS = 10;
/** …and confirms if this many of them are measured over `slowTickMs`. */
export const SLOW_TRIAL_CONFIRM = 3;
/**
 * Trial deaths in a row at the same tick that confirm a CPU overrun. A real overrun dies at the
 * same tick every time; restarts land wherever the trial happens to be.
 */
export const TRIAL_DEATHS_TO_CONFIRM = 4;
/** Trial attempts (deaths without a match, restarts) before giving up: inconclusive. */
export const TRIAL_MAX_ATTEMPTS = 10;
/**
 * Each trial waits a random 0..this ms (wall time, no CPU) before it starts, so restarts timed
 * from the invocation's start (deploys, retries) don't hit the same tick every time.
 */
export const TRIAL_JITTER_MS = 250;
/**
 * After each of the suspect's calls the trial records "between calls" and waits a random
 * 0..this ms (no CPU). Most of a trial's wall time is then between calls, where a restart counts
 * for nothing; one that lands in a call hits a call in proportion to its length (starting the
 * sandbox life is the longest for an honest bot, hence four matching deaths). A real overrun never
 * returns from its call, so it always dies in the same one.
 */
export const TRIAL_GAP_MS = 100;

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
  /** Watch mode, and only the suspect's own call can explain it: put the suspect on trial. */
  | { kind: "suspect"; lifeId: string; gapMs: number; callMs: number };

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
    return { kind: "suspect", lifeId: marker.suspectLife, gapMs, callMs };
  }
  return { kind: "overrun", gapMs };
}

/** A suspect on trial. Lives in the room's meta until the verdict. */
export interface Trial {
  kind: "cpu" | "slow";
  lifeId: string;
  /** cpu: the tick the suspect was running at when the watched batch died. */
  untilTick: number;
  /** cpu: the crashed batch's pending tickets (the suspect may be one of its spawns). */
  maxPendingSeq: number;
  /** Calls (`init@<tick>`, `tick@<tick>`) in which trials of this suspect died with CPU-limit
   * evidence, in order. */
  deaths: string[];
  /** Trial invocations so far that didn't complete. */
  attempts: number;
  /** Why it was suspected, for the strike's detail. */
  reason: string;
}

/** What a dead trial (only the suspect's code ran) means. Records the attempt in `trial`. */
export function judgeTrialCrash(
  trial: Trial,
  marker: CrashMarker & { trialCall: string | null },
  now: number,
  cpuLimitMs: number,
): "confirmed" | "retry" | "inconclusive" {
  const attempts = trial.attempts + 1;
  const cpu = now - marker.startedAt >= CPU_EVIDENCE * cpuLimitMs && marker.trialCall !== null;
  if (cpu) {
    const deaths = [...trial.deaths, marker.trialCall as string];
    const last = deaths.slice(-TRIAL_DEATHS_TO_CONFIRM);
    if (last.length === TRIAL_DEATHS_TO_CONFIRM && last.every((t) => t === last[0])) {
      return "confirmed";
    }
    trial.deaths = deaths;
  }
  trial.attempts = attempts;
  return attempts >= TRIAL_MAX_ATTEMPTS ? "inconclusive" : "retry";
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
