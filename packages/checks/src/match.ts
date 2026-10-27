import {
  type Action,
  buildBotInfo,
  buildBotState,
  createWorld,
  type DeathCause,
  type Fault,
  type Snake,
  spawnSnake,
  step,
  type World,
} from "@zerosnake/engine";
import { houseBots } from "@zerosnake/house-bots";
import type { BotLife, Death, Sandbox } from "@zerosnake/sandbox";
import { type Bot, type BotInfo, createTickLog, LOG_LIMIT_BYTES } from "@zerosnake/sdk";
import type { CostMeter, Overrun } from "./cost.ts";
import { type Disguise, disguiseFor } from "./disguise.ts";
import {
  batchTicks,
  DEFAULT_MAX_SNAKES,
  DEFAULT_MIN_AUTHORS,
  type HouseKind,
  houseFill,
} from "./room-rules.ts";

/** What drives the candidate's seat: the uploaded bundle in the sandbox, or a house bot. */
export type Seat =
  | { kind: "sandbox"; sandbox: Sandbox; bundle: string; meter: CostMeter }
  | { kind: "house"; bot: Bot<object> };

export interface MatchOptions {
  seed: number;
  /** Ticks from the candidate's first spawn. */
  ticks: number;
  opBudget: number;
}

/** How a life in the candidate's seat ended. `window` = still alive when the match ended. */
export type LifeEnd = DeathCause | "window";

export interface LifeResult {
  ticks: number;
  score: number;
  end: LifeEnd;
}

/** A sandbox death by timeout, error or OOM: this fails the run check. */
export interface FaultDetails {
  seed: number;
  /** World tick of the fatal tick. */
  tick: number;
  /** Which life of this match (1-based). */
  life: number;
  /** `lifeTick` of the fatal tick. */
  lifeTick: number;
  /** The life was dead before its first tick: loading the module or `init()` failed. */
  atLoad: boolean;
  fault: Fault;
  reason: Death["reason"];
  message: string;
  /** The bot's last log lines before it died (newest last). */
  log: string[];
}

/** Per-tick sandbox numbers of the candidate, summed over a match. */
export interface TickStats {
  ticks: number;
  /** Ticks that went over budget without killing the bot (fewer than 3 in a row). */
  timeoutTicks: number;
  /** Ticks that threw without killing the bot. */
  errorTicks: number;
  /** The first exception, for the report. */
  firstError: { seed: number; tick: number; message: string } | null;
  peakInterrupts: number;
  peakWork: number;
}

export interface MatchResult {
  seed: number;
  /** Ticks of the match window played (fewer than asked when it faulted or a cap was hit). */
  ticks: number;
  lives: LifeResult[];
  fault: FaultDetails | null;
  overrun: Overrun | null;
  stats: TickStats;
}

/** What a test can watch of the room process (to check it against the arena's rules). */
export interface RoomTrace {
  batch?(e: { tick: number; ticks: number; bots: number; starts: number }): void;
  spawn?(e: { tick: number; id: string; author: string }): void;
  death?(e: { tick: number; id: string }): void;
}

const KEEP_LOG_LINES = 20;

/** Who plays a seat: the candidate, a "user" (a house bot under a user name), or the house fill. */
type SeatRef =
  | { kind: "candidate" }
  | { kind: "user"; index: number }
  | { kind: "house"; bot: HouseKind };

interface Member {
  ref: SeatRef;
  author: string;
  life: SeatLife;
}

interface SeatLife {
  tick(world: World, snake: Snake): Action;
  dispose(): void;
}

export function emptyStats(): TickStats {
  return {
    ticks: 0,
    timeoutTicks: 0,
    errorTicks: 0,
    firstError: null,
    peakInterrupts: 0,
    peakWork: 0,
  };
}

/**
 * Plays one check match: an arena room run by RoomDO's rules (`room-rules.ts`), on the default
 * engine config. The room opens at tick 0 or at an older room's tick. Snakes join only at batch
 * boundaries, tickets first (the candidate and the "users", house bots under user names), then
 * the house fill tops the room up to 5 authors. A batch lasts `batchTicks(bots, starts)` ticks.
 * The candidate's ticket arrives after a pre-roll, and after each death it rejoins at the next
 * batch, like the users. The match lasts `ticks` ticks from the candidate's first spawn. Names,
 * start tick and pre-roll come from {@link disguiseFor}, so nothing the bot sees says "check"
 * (tests pass their own `disguise` to play a room as the arena would set it up).
 *
 * House bots run natively (they are trusted and deterministic); only the candidate runs in the
 * sandbox, alone, so its OOM behaviour doesn't depend on anyone else. Stops early on the
 * candidate's first sandbox death or when the suite's cost meter runs out.
 */
export function playMatch(
  seat: Seat,
  { seed, ticks, opBudget }: MatchOptions,
  trace: RoomTrace = {},
  disguise: Disguise = disguiseFor(seed),
): MatchResult {
  const world = createWorld({ seed });
  world.tick = disguise.startTick;
  const limits = { opBudget, logLimitBytes: LOG_LIMIT_BYTES };
  const lives: LifeResult[] = [];
  const stats = emptyStats();
  // Set from inside the candidate's tick, so held in an object TypeScript doesn't narrow.
  const stop: { fault: FaultDetails | null; overrun: Overrun | null } = {
    fault: null,
    overrun: null,
  };
  const stopped = () => stop.fault !== null || stop.overrun !== null;
  let recentLog: string[] = [];

  /** Living snakes by id, in spawn order. */
  const members = new Map<string, Member>();
  /** Tickets waiting for the next batch, in arrival order. */
  let pending: SeatRef[] = disguise.users.map((_, index) => ({ kind: "user", index }));
  const livesStarted = new Map<string, number>();
  let candidateId: string | null = null;
  /** World tick of the candidate's first spawn: the match window starts there. */
  let windowStart: number | null = null;
  let ticketSent = false;

  const userOf = (index: number) => disguise.users[index] as Disguise["users"][number];

  const overrun = (o: Omit<Overrun, "seed" | "tick"> | null) => {
    if (o) stop.overrun = { ...o, seed, tick: world.tick };
  };

  const sandboxLife = (life: BotLife, meter: CostMeter): SeatLife => {
    const atLoad = life.death !== null;
    return {
      tick(w, snake) {
        const state = buildBotState(w, snake);
        const r = life.tick(state);
        stats.ticks++;
        stats.peakInterrupts = Math.max(stats.peakInterrupts, r.interrupts);
        stats.peakWork = Math.max(stats.peakWork, r.work);
        if (r.log.lines.length > 0) {
          recentLog = [...recentLog, ...r.log.lines].slice(-KEEP_LOG_LINES);
        }
        if (r.death) {
          // The ticks of the fatal streak are part of the death, not separate warnings.
          if (r.death.reason === "timeouts") stats.timeoutTicks -= r.strikes - 1;
          if (r.death.reason === "errors") {
            stats.errorTicks -= r.errors - 1;
            if (stats.errorTicks === 0) stats.firstError = null;
          }
          stop.fault = {
            seed,
            tick: w.tick,
            life: lives.length + 1,
            lifeTick: state.lifeTick,
            atLoad,
            fault: r.death.fault,
            reason: r.death.reason,
            message: r.death.message,
            log: recentLog,
          };
          return r.action;
        }
        if (r.outcome === "timeout") {
          stats.timeoutTicks++;
        } else if (r.outcome === "error") {
          stats.errorTicks++;
          stats.firstError ??= { seed, tick: w.tick, message: r.error ?? "" };
        }
        overrun(meter.charge(r));
        return r.action;
      },
      dispose: () => life.dispose(),
    };
  };

  /** A ticket's next life: id and author as the arena would give them. */
  const ticketEntry = (ref: SeatRef) => {
    const identity = ref.kind === "user" ? userOf(ref.index).identity : disguise.candidate;
    const n = livesStarted.get(identity.author) ?? 0;
    livesStarted.set(identity.author, n + 1);
    return { lifeId: identity.lifeId(n), author: identity.author, ref };
  };

  const start = (e: { lifeId: string; author: string; ref: SeatRef }): void => {
    const snake = spawnSnake(world, { id: e.lifeId, author: e.author });
    trace.spawn?.({ tick: world.tick, id: e.lifeId, author: e.author });
    const info = buildBotInfo(world, snake, limits);
    const { ref } = e;
    let life: SeatLife;
    if (ref.kind === "house") {
      life = nativeLife(houseBots[ref.bot], info);
    } else if (ref.kind === "user") {
      life = nativeLife(houseBots[userOf(ref.index).kind], info);
    } else {
      candidateId = e.lifeId;
      windowStart ??= world.tick;
      if (seat.kind === "house") {
        life = nativeLife(seat.bot, info);
      } else {
        const sandboxed = seat.sandbox.startLife(seat.bundle, info);
        recentLog = sandboxed.loadLog.lines.slice(-KEEP_LOG_LINES);
        life = sandboxLife(sandboxed, seat.meter);
        overrun(seat.meter.checkClock());
      }
    }
    members.set(e.lifeId, { ref, author: e.author, life });
  };

  const windowOver = () => windowStart !== null && world.tick >= windowStart + ticks;

  const playTick = (): void => {
    const actions: Record<string, Action> = {};
    for (const snake of world.snakes) {
      actions[snake.id] = (members.get(snake.id) as Member).life.tick(world, snake);
    }
    const faults = stop.fault && candidateId ? { [candidateId]: stop.fault.fault } : {};
    step(world, actions, faults);
    for (const d of world.deaths) {
      const m = members.get(d.id);
      if (!m) continue;
      trace.death?.({ tick: world.tick, id: d.id });
      m.life.dispose();
      members.delete(d.id);
      // Tickets come back for the next batch; house seats are refilled by the house fill.
      if (m.ref.kind === "candidate") {
        candidateId = null;
        lives.push({ ticks: d.lifeTicks, score: d.score, end: d.cause });
      }
      if (m.ref.kind !== "house") pending.push(m.ref);
    }
  };

  while (!stopped() && !windowOver()) {
    if (!ticketSent && world.tick >= disguise.startTick + disguise.preroll) {
      pending.push({ kind: "candidate" });
      ticketSent = true;
    }
    // Plan the batch the way RoomDO does: tickets, then the house fill, then the batch size.
    const spawns: { lifeId: string; author: string; ref: SeatRef }[] = [];
    for (const ref of pending) {
      if (members.size + spawns.length < DEFAULT_MAX_SNAKES) spawns.push(ticketEntry(ref));
    }
    pending = [];
    for (const h of houseFill(
      [...members.values(), ...spawns],
      DEFAULT_MAX_SNAKES,
      DEFAULT_MIN_AUTHORS,
      world.tick,
    )) {
      spawns.push({ lifeId: h.lifeId, author: h.author, ref: { kind: "house", bot: h.house } });
    }
    const bots = members.size + spawns.length;
    const batch = batchTicks(bots, spawns.length);
    trace.batch?.({ tick: world.tick, ticks: batch, bots, starts: spawns.length });
    for (const e of spawns) if (!stopped()) start(e);
    for (let k = 0; k < batch && !stopped() && !windowOver(); k++) playTick();
  }

  const alive = world.snakes.find((s) => s.id === candidateId);
  if (alive) lives.push({ ticks: alive.lifeTick, score: alive.score, end: "window" });
  for (const m of members.values()) m.life.dispose();
  const played = windowStart === null ? 0 : world.tick - windowStart;
  return { seed, ticks: played, lives, fault: stop.fault, overrun: stop.overrun, stats };
}

function nativeLife(bot: Bot<object>, info: BotInfo): SeatLife {
  const mem = bot.init?.(info) ?? {};
  const { log } = createTickLog(0);
  return {
    tick(world, snake) {
      return bot.tick(buildBotState(world, snake), mem, log);
    },
    dispose() {},
  };
}
