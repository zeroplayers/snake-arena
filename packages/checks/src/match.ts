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
import { type HouseBotName, houseBots } from "@zerosnake/house-bots";
import type { BotLife, Death, Sandbox } from "@zerosnake/sandbox";
import { type Bot, type BotInfo, createTickLog, LOG_LIMIT_BYTES } from "@zerosnake/sdk";
import type { CostMeter, Overrun } from "./cost.ts";
import { disguiseFor, type Identity } from "./disguise.ts";

/** Opponents in every check match, in spawn order. */
export const OPPONENTS: readonly HouseBotName[] = ["easy", "medium", "hard", "chaos"];

/** What drives the candidate's seat: the uploaded bundle in the sandbox, or a house bot. */
export type Seat =
  | { kind: "sandbox"; sandbox: Sandbox; bundle: string; meter: CostMeter }
  | { kind: "house"; bot: Bot<object> };

export interface MatchOptions {
  seed: number;
  /** Ticks after the candidate joins. */
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
  /** Candidate ticks simulated (fewer than asked when it faulted or a suite cap was hit). */
  ticks: number;
  lives: LifeResult[];
  fault: FaultDetails | null;
  overrun: Overrun | null;
  stats: TickStats;
}

const KEEP_LOG_LINES = 20;
const CANDIDATE = "candidate";
type SeatKey = HouseBotName | typeof CANDIDATE;

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
 * Plays one check match on the default engine config. The opponents spawn first at a start tick
 * far from 0 and play a pre-roll alone; then the candidate joins and plays `ticks` ticks. Every
 * seat respawns as soon as it dies. Names, start tick and pre-roll come from {@link disguiseFor},
 * so nothing the bot sees says "check".
 *
 * House bots run natively (they are trusted and deterministic); only the candidate runs in the
 * sandbox, alone, so its OOM behaviour doesn't depend on anyone else. Stops early on the
 * candidate's first sandbox death or when the suite's cost meter runs out.
 */
export function playMatch(seat: Seat, { seed, ticks, opBudget }: MatchOptions): MatchResult {
  const disguise = disguiseFor(seed, OPPONENTS);
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

  const identities = new Map<SeatKey, Identity>([
    [CANDIDATE, disguise.candidate],
    ...OPPONENTS.map((k) => [k, disguise.opponents[k]] as const),
  ]);
  const spawns = new Map<SeatKey, number>();
  /** Seat of every snake id ever spawned, and the bot of each living one. */
  const seatOf = new Map<string, SeatKey>();
  const running = new Map<string, SeatLife>();
  let candidateId: string | null = null;

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

  const spawn = (key: SeatKey): void => {
    const identity = identities.get(key) as Identity;
    const n = spawns.get(key) ?? 0;
    spawns.set(key, n + 1);
    const id = identity.lifeId(world.tick, n);
    const snake = spawnSnake(world, { id, author: identity.author });
    seatOf.set(id, key);
    const info = buildBotInfo(world, snake, limits);
    if (key !== CANDIDATE) {
      running.set(id, nativeLife(houseBots[key], info));
      return;
    }
    candidateId = id;
    if (seat.kind === "house") {
      running.set(id, nativeLife(seat.bot, info));
    } else {
      const life = seat.sandbox.startLife(seat.bundle, info);
      recentLog = life.loadLog.lines.slice(-KEEP_LOG_LINES);
      running.set(id, sandboxLife(life, seat.meter));
      overrun(seat.meter.checkClock());
    }
  };

  const playTick = (last: boolean): void => {
    const actions: Record<string, Action> = {};
    for (const snake of world.snakes) {
      actions[snake.id] = (running.get(snake.id) as SeatLife).tick(world, snake);
    }
    const faults = stop.fault && candidateId ? { [candidateId]: stop.fault.fault } : {};
    step(world, actions, faults);
    for (const d of world.deaths) {
      running.get(d.id)?.dispose();
      running.delete(d.id);
      const key = seatOf.get(d.id) as SeatKey;
      if (key === CANDIDATE) {
        candidateId = null;
        lives.push({ ticks: d.lifeTicks, score: d.score, end: d.cause });
      }
      // Nobody respawns after the last tick: a life of 0 ticks would only dilute the mean.
      if (!last && !stopped()) spawn(key);
    }
  };

  for (const kind of OPPONENTS) spawn(kind);
  for (let t = 0; t < disguise.preroll; t++) playTick(false);
  spawn(CANDIDATE);

  let t = 0;
  for (; t < ticks && !stopped(); t++) playTick(t === ticks - 1);

  const alive = world.snakes.find((s) => s.id === candidateId);
  if (alive) lives.push({ ticks: alive.lifeTick, score: alive.score, end: "window" });
  for (const life of running.values()) life.dispose();
  return { seed, ticks: t, lives, fault: stop.fault, overrun: stop.overrun, stats };
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
