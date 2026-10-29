/**
 * The room's CPU backstop: what a batch that died means, whom to evict so the room keeps going,
 * and how long to watch the room afterwards. Pure functions over wall-clock numbers, so every rule
 * is unit-tested.
 *
 * **No punishment from here.** Strikes and bans come only from the sandbox's deterministic meter
 * (a tick over budget is a strike, three in a row kill the life by `timeout`). A batch killed by
 * the DO CPU limit is either a platform restart or a hole in the meter (huge-string operators,
 * see `packages/sandbox` "Known gaps"), and timing can't tell which. So kills only ever buy the
 * room **progress**: the bot whose call keeps dying is evicted (its life ends with the neutral
 * cause `evicted`, which ratings skip), and a version evicted again and again is quarantined
 * (no new lives, flagged in D1 for a person to look at), never banned.
 *
 * The evidence: wall-clock time at I/O. The clock is frozen during CPU work, but CPU time never
 * exceeds wall time, so a batch killed by the CPU limit left its marker at least `cpuLimitMs`
 * before the next invocation looked at it. Timing is only used to **spare**: anything quicker was a
 * restart (deploy, eviction, runtime update) and counts for nothing.
 *
 * Watch mode (after a kill) runs the room itself, not a replay: bots run forward and keep their
 * memory, with all their neighbours. Before each bot call it syncs "this call is running", after it
 * "between calls" followed by a random wait (wall time only), and it stops a batch early once
 * `WATCH_STOP_SHARE` of the limit has passed. So a watched invocation can't die of aggregate cost,
 * a kill names the call it interrupted (or none), and most of a watched batch's wall time is
 * between calls, where a restart names nobody.
 *
 * A kill rolls the room back to its last saved frame and restarts every bot there, so a bot that
 * blows the limit by itself does it again on every attempt, whatever it depends on (its memory,
 * its neighbours): it is named by every watched kill. A restart lands wherever the room happens to
 * be, and most of a watched batch's wall time is between calls. So the room keeps a **kill
 * window** (`nextKills`): the watched kills that named a life, in order, since the last one that
 * named nobody (only a restart lands between calls), and only while the room is less than
 * `KILL_WINDOW_TICKS` past them (kills far apart in game time don't add up over a long life).
 * - A life named `KILLS_TO_EVICT` times in the window is evicted, whatever the kills in between
 *   named: colluding bots that take turns can't reset each other's count.
 * - `ROOM_KILLS_TO_EVICT` kills in the window evict every life they named: however many bots take
 *   turns, the room loses at most that many kills before it moves on.
 *
 * The window ages, so a bot that burns only every few thousand ticks of its memory (each kill
 * restarts it with none) never collects `KILLS_TO_EVICT` kills in it. So the room also keeps a
 * **version tally** (`nextVersionKills`): every kill that named a version's life, across lives,
 * until a kill names nobody (as for the window: only a restart lands between calls) or a week has
 * passed. `VERSION_KILLS_TO_QUARANTINE` of them evict the life and quarantine the version. Rooms
 * also write each named kill to D1 (`version_kills`, retracted when the tally is emptied), where
 * the same count across every room quarantines a version whose lives each die in a different room.
 *
 * A watched call that **returns** after running past `WATCH_ABORT_SHARE` of the room's budget by
 * itself is named too (`blameCall`), as a kill would have: the batch ends there, so a call that
 * takes most of the budget without reaching the CPU limit can't stall the room forever by making
 * every rerun abandon the same tick. So is the slowest call of a tick that watch mode abandons when
 * the tick's bot calls alone ran past the stop share. Bot calls are milliseconds; only code the meter
 * can't see takes seconds.
 */

/** A marker older than this share of the CPU limit is consistent with a CPU kill (clock skew). */
export const CPU_EVIDENCE = 0.9;
/**
 * Watch mode ends a batch between ticks after this share of the CPU limit (wall time, minus the
 * random waits, which use no CPU)…
 */
export const WATCH_STOP_SHARE = 0.3;
/** …and abandons the tick in progress after this share (only aggregate overload gets there). */
export const WATCH_ABORT_SHARE = 0.6;
/** It also ends a batch between ticks once its wall time, waits included, reaches the limit. */
export const WATCH_WALL_SHARE = 1;
/** Watch length after the first CPU incident in a day (one minute of game time). */
export const WATCH_TICKS = 600;
/**
 * Watch length after the second (ten minutes of game time). It was the life cap, so every life
 * started and ended under watch; lives now last until the snake dies (up to 24 hours), and a
 * watch that long would slow the room for hours, so it is its own constant.
 */
export const WATCH_REPEAT_TICKS = 6000;
/** CPU incidents within this window escalate the watch. */
export const INCIDENT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Watched kills in the kill window, each inside one life's call, that evict that life. */
export const KILLS_TO_EVICT = 3;
/** Watched kills in the kill window that evict every life they named. */
export const ROOM_KILLS_TO_EVICT = 6;
/**
 * A named kill leaves the window once the room has committed this many ticks past the frame it
 * restarted from (5 minutes of game time, half a life): a bot named again and again gets no
 * further than that between kills, a rare kill of an honest one ages out.
 */
export const KILL_WINDOW_TICKS = 3000;
/** Evictions of one version (in this room) that quarantine it. */
export const EVICTIONS_TO_QUARANTINE = 2;
/**
 * Named kills of one version in its tally (in a room, or in D1 across rooms) that quarantine it:
 * as many as two evictions take.
 */
export const VERSION_KILLS_TO_QUARANTINE = 2 * KILLS_TO_EVICT;
/** A version's named kills count toward its quarantine for this long (wall time). */
export const VERSION_KILL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Watch mode waits a random 0..(this + `WATCH_GAP_FACTOR` × the call's measured duration) ms after
 * each bot call, marked "between calls", at most `WATCH_GAP_CAP_SHARE` of the CPU limit. The wait
 * is wall time only (no CPU). It keeps a life's share of a watched batch's wall time small, so
 * restarts rarely name the same life twice in a row, while a real overrun never returns from its
 * call and is named every time. The first call of a batch waits a random 0..cap ms before it too:
 * every rerun starts the bots in the same order, so its first call would otherwise sit at the same
 * offset from the invocation's start every time.
 */
export const DEFAULT_WATCH_GAP_MS = 10;
export const WATCH_GAP_FACTOR = 20;
export const WATCH_GAP_CAP_SHARE = 0.25;

/** A bot call in progress (watch mode), as the marker records it. */
export interface BotCall {
  lifeId: string;
  kind: "init" | "tick";
  tick: number;
  /** Wall ms when the call was about to start (before the sync that made it durable). */
  at: number;
  /**
   * Wall ms from the invocation's start to `at`, minus the random waits (which use no CPU): an
   * upper bound on the CPU used before the call.
   */
  before: number;
}

/** What `RoomStore` keeps of a batch in progress, as far as the backstop is concerned. */
export interface CrashMarker {
  /** Wall ms when the batch's invocation started (written before the batch's code ran). */
  startedAt: number;
  watch: boolean;
  /** Watch mode: the bot call running, or null between calls. */
  call: BotCall | null;
}

export type Verdict =
  /** Too quick to be the CPU limit: a restart. Counts for nothing; the batch runs again. */
  | { kind: "restart"; gapMs: number }
  /** Possibly the CPU limit, with no call to name (normal mode, or between calls). */
  | { kind: "overrun"; gapMs: number }
  /** Watch mode, inside one bot's call, and long enough for that call to have used the CPU. */
  | { kind: "suspect"; call: BotCall; gapMs: number; callMs: number };

export function judgeCrash(marker: CrashMarker, now: number, cpuLimitMs: number): Verdict {
  const gapMs = now - marker.startedAt;
  if (gapMs < CPU_EVIDENCE * cpuLimitMs) return { kind: "restart", gapMs };
  const call = marker.call;
  if (!marker.watch || call === null) return { kind: "overrun", gapMs };
  // Everything before the call used at most `before` of CPU, so a CPU kill inside it means the
  // call alone used at least `limit - before`, and that much wall time must have passed since.
  // Watch mode stops before `before` gets near the limit. (This only spares; it names no one
  // that a kill inside the call wouldn't.)
  const before = call.before;
  const callMs = now - call.at;
  if (before <= WATCH_ABORT_SHARE * cpuLimitMs && callMs >= CPU_EVIDENCE * (cpuLimitMs - before)) {
    return { kind: "suspect", call, gapMs, callMs };
  }
  return { kind: "overrun", gapMs };
}

/** A watched kill that named a life: its call, and the frame the room restarted from. */
export interface NamedKill {
  lifeId: string;
  tick: number;
}

/**
 * The kill window after a verdict (oldest kill first), and whom it evicts. A watched kill naming
 * nobody (between calls: a real overrun never gets there) empties it. Restarts, and kills outside
 * watch mode (no call to name), leave it as it was. `tick` is the frame the room restarts from.
 *
 * An evicted life's kills stay in the window (it is never named again), so they still count
 * toward `ROOM_KILLS_TO_EVICT`, which evicts the lives named fewer than `KILLS_TO_EVICT` times
 * and empties the window.
 */
export function nextKills(
  kills: readonly NamedKill[],
  verdict: Verdict,
  watched: boolean,
  tick: number,
  windowTicks = KILL_WINDOW_TICKS,
): { kills: NamedKill[]; evict: string[] } {
  if (verdict.kind === "restart") return { kills: [...kills], evict: [] };
  if (verdict.kind === "overrun") return { kills: watched ? [] : [...kills], evict: [] };
  const lifeId = verdict.call.lifeId;
  const window = [...ageKills(kills, tick, windowTicks), { lifeId, tick }];
  const named = new Map<string, number>();
  for (const k of window) named.set(k.lifeId, (named.get(k.lifeId) ?? 0) + 1);
  const reached = named.get(lifeId) === KILLS_TO_EVICT;
  if (window.length >= ROOM_KILLS_TO_EVICT) {
    // Lives named `KILLS_TO_EVICT` times before this kill are evicted already.
    const evict = [...named].filter(([id, n]) => n < KILLS_TO_EVICT || (reached && id === lifeId));
    return { kills: [], evict: evict.map(([id]) => id) };
  }
  return { kills: window, evict: reached ? [lifeId] : [] };
}

/** The kills still in the window once the room has committed up to `tick`. */
export function ageKills(
  kills: readonly NamedKill[],
  tick: number,
  windowTicks = KILL_WINDOW_TICKS,
): NamedKill[] {
  return kills.filter((k) => tick - k.tick < windowTicks);
}

/** A watched kill that named a deployed version's life (`versionId` null for house bots). */
export interface VersionKill {
  /** Unique, so D1 counts a kill delivered twice once. */
  id: string;
  versionId: string;
  author: string;
  lifeId: string;
  /** Room tick of the call it interrupted. */
  tick: number;
  /** Wall ms. */
  at: number;
}

/**
 * The version tally after a verdict (`kill`: the named call's version, if it has one), what to
 * retract from D1, and whether `kill`'s version is now quarantined. Like the kill window, a watched
 * kill that names nobody empties it (retracting every kill in it) and restarts and unwatched kills
 * leave it; unlike the window, it doesn't age with game time, only after `VERSION_KILL_WINDOW_MS`.
 */
export function nextVersionKills(
  kills: readonly VersionKill[],
  verdict: Verdict,
  watched: boolean,
  kill: VersionKill | null,
  now: number,
): { kills: VersionKill[]; retract: VersionKill[]; quarantine: boolean } {
  const live = kills.filter((k) => now - k.at < VERSION_KILL_WINDOW_MS);
  if (verdict.kind === "overrun" && watched) return { kills: [], retract: live, quarantine: false };
  if (verdict.kind !== "suspect" || !kill) return { kills: live, retract: [], quarantine: false };
  const next = [...live, kill];
  const count = next.filter((k) => k.versionId === kill.versionId).length;
  return { kills: next, retract: [], quarantine: count >= VERSION_KILLS_TO_QUARANTINE };
}

/** A watched bot call that returned, and its own wall time (from after its marker's sync). */
export interface TimedCall {
  call: BotCall;
  ms: number;
}

/**
 * The call of a watched tick (`calls`, in order) to name as a kill, or null: one that by itself ran
 * past `WATCH_ABORT_SHARE` of `limitMs` (the room's budget); or, when watch mode abandons the tick
 * (`abandoned`), its slowest `tick` call, if its `tick` calls together ran past the share between
 * the stop and the abort (the tick started below the stop share, so they alone made it overrun).
 * Starts don't count toward that: their bot code has an op budget of its own. (A start's time is
 * the bot's own: the room instruments bundles before marking any call, see `room/bundles.ts`.)
 */
export function blameCall(
  calls: readonly TimedCall[],
  abandoned: boolean,
  limitMs: number,
): TimedCall | null {
  let slowest: TimedCall | null = null;
  let slowestTick: TimedCall | null = null;
  let ticks = 0;
  for (const c of calls) {
    if (!slowest || c.ms > slowest.ms) slowest = c;
    if (c.call.kind !== "tick") continue;
    ticks += c.ms;
    if (!slowestTick || c.ms > slowestTick.ms) slowestTick = c;
  }
  if (slowest && slowest.ms >= WATCH_ABORT_SHARE * limitMs) return slowest;
  if (abandoned && ticks >= (WATCH_ABORT_SHARE - WATCH_STOP_SHARE) * limitMs) return slowestTick;
  return null;
}

/** How long to wait after a watched bot call that took `callMs` (wall, syncs included). */
export function watchGapMs(
  callMs: number,
  gapMs: number,
  random: number,
  cpuLimitMs: number,
): number {
  const wait = random * (gapMs + WATCH_GAP_FACTOR * Math.max(0, callMs));
  return Math.min(wait, WATCH_GAP_CAP_SHARE * cpuLimitMs);
}

export interface WatchWindow {
  /** Watch until the world reaches this tick… */
  untilTick: number;
  /** …and until this wall ms. */
  untilMs: number;
}

/**
 * How long to watch after a CPU incident, given how many there were in the last
 * `INCIDENT_WINDOW_MS` (this one included): a minute of game time for the first, ten minutes
 * (`WATCH_REPEAT_TICKS`) for the second, and a day of wall time from the third on. Never shortens
 * a watch already running.
 */
export function watchWindow(
  current: WatchWindow,
  recentIncidents: number,
  tick: number,
  now: number,
): WatchWindow {
  const next =
    recentIncidents <= 1
      ? { untilTick: tick + WATCH_TICKS, untilMs: 0 }
      : recentIncidents === 2
        ? { untilTick: tick + WATCH_REPEAT_TICKS, untilMs: 0 }
        : { untilTick: tick + WATCH_REPEAT_TICKS, untilMs: now + INCIDENT_WINDOW_MS };
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
