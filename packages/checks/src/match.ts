import {
  type Action,
  buildBotInfo,
  buildBotState,
  createWorld,
  type DeathCause,
  type Fault,
  spawnSnake,
  step,
  type World,
} from "@zerosnake/engine";
import { type HouseBotName, houseBots } from "@zerosnake/house-bots";
import type { BotLife, Death, Sandbox } from "@zerosnake/sandbox";
import { type Bot, type BotInfo, createTickLog, LOG_LIMIT_BYTES } from "@zerosnake/sdk";

/** The snake id of the bot under test. House bots are named after themselves. */
export const CANDIDATE_ID = "you";
/** Opponents in every check match, in spawn order (the candidate's seat comes first). */
export const OPPONENTS: readonly HouseBotName[] = ["easy", "medium", "hard", "chaos"];

/** What drives the candidate's seat: the uploaded bundle in the sandbox, or a house bot. */
export type Seat =
  | { kind: "sandbox"; sandbox: Sandbox; bundle: string }
  | { kind: "house"; bot: Bot<object> };

export interface MatchOptions {
  seed: number;
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
  /** `lifeTick` of the fatal tick (0 also when the life failed to start, reason `load`). */
  lifeTick: number;
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
  /** Ticks simulated (fewer than asked when the candidate faulted). */
  ticks: number;
  lives: LifeResult[];
  fault: FaultDetails | null;
  stats: TickStats;
}

const KEEP_LOG_LINES = 20;

interface SeatLife {
  tick(world: World): Action;
  dispose(): void;
}

/**
 * Plays one check match: the candidate's seat plus {@link OPPONENTS}, `ticks` ticks on the
 * default engine config, every seat respawning as soon as it dies. House bots run natively (they
 * are trusted and deterministic); only the candidate runs in the sandbox, alone, so its OOM
 * behaviour doesn't depend on anyone else. Stops early on the candidate's first sandbox death.
 */
export function playMatch(seat: Seat, { seed, ticks, opBudget }: MatchOptions): MatchResult {
  const world = createWorld({ seed });
  const limits = { opBudget, logLimitBytes: LOG_LIMIT_BYTES };
  const lives: LifeResult[] = [];
  const stats: TickStats = {
    ticks: 0,
    timeoutTicks: 0,
    errorTicks: 0,
    firstError: null,
    peakInterrupts: 0,
    peakWork: 0,
  };
  let fault: FaultDetails | null = null;
  let recentLog: string[] = [];

  const seats = new Map<string, SeatLife>();
  const spawn = (id: string): void => {
    const snake = spawnSnake(world, { id, author: id === CANDIDATE_ID ? CANDIDATE_ID : "house" });
    const info = buildBotInfo(world, snake, limits);
    if (id !== CANDIDATE_ID) {
      seats.set(id, nativeLife(houseBots[id as HouseBotName], info));
    } else if (seat.kind === "house") {
      seats.set(id, nativeLife(seat.bot, info));
    } else {
      const life = seat.sandbox.startLife(seat.bundle, info);
      recentLog = [...life.loadLog.lines].slice(-KEEP_LOG_LINES);
      seats.set(id, sandboxLife(life));
    }
  };

  const sandboxLife = (life: BotLife): SeatLife => ({
    tick(w) {
      const state = buildBotState(w, CANDIDATE_ID);
      const r = life.tick(state);
      stats.ticks++;
      stats.peakInterrupts = Math.max(stats.peakInterrupts, r.interrupts);
      stats.peakWork = Math.max(stats.peakWork, r.work);
      if (r.log.lines.length > 0) recentLog = [...recentLog, ...r.log.lines].slice(-KEEP_LOG_LINES);
      if (r.death) {
        // The ticks of the fatal streak are part of the death, not separate warnings.
        if (r.death.reason === "timeouts") stats.timeoutTicks -= r.strikes - 1;
        if (r.death.reason === "errors") {
          stats.errorTicks -= r.errors - 1;
          if (stats.errorTicks === 0) stats.firstError = null;
        }
        fault = {
          seed,
          tick: w.tick,
          life: lives.length + 1,
          lifeTick: state.lifeTick,
          fault: r.death.fault,
          reason: r.death.reason,
          message: r.death.message,
          log: recentLog,
        };
      } else if (r.outcome === "timeout") {
        stats.timeoutTicks++;
      } else if (r.outcome === "error") {
        stats.errorTicks++;
        stats.firstError ??= { seed, tick: w.tick, message: r.error ?? "" };
      }
      return r.action;
    },
    dispose: () => life.dispose(),
  });

  spawn(CANDIDATE_ID);
  for (const name of OPPONENTS) spawn(name);

  let t = 0;
  for (; t < ticks && !fault; t++) {
    const actions: Record<string, Action> = {};
    for (const snake of world.snakes) {
      actions[snake.id] = (seats.get(snake.id) as SeatLife).tick(world);
    }
    // Set by the candidate's tick() above; TypeScript can't see assignments in closures.
    const currentFault = fault as FaultDetails | null;
    step(world, actions, currentFault ? { [CANDIDATE_ID]: currentFault.fault } : {});
    for (const d of world.deaths) {
      seats.get(d.id)?.dispose();
      seats.delete(d.id);
      if (d.id === CANDIDATE_ID) {
        lives.push({ ticks: d.lifeTicks, score: d.score, end: d.cause });
      }
      // Nobody respawns after the last tick: a life of 0 ticks would only dilute the mean.
      if (t < ticks - 1 && !fault) spawn(d.id);
    }
  }
  for (const snake of world.snakes) {
    if (snake.id === CANDIDATE_ID) {
      lives.push({ ticks: snake.lifeTick, score: snake.score, end: "window" });
    }
  }
  for (const s of seats.values()) s.dispose();
  return { seed, ticks: t, lives, fault, stats };
}

function nativeLife(bot: Bot<object>, info: BotInfo): SeatLife {
  const mem = bot.init?.(info) ?? {};
  const { log } = createTickLog(0);
  return {
    tick(world) {
      return bot.tick(buildBotState(world, info.snakeId), mem, log);
    },
    dispose() {},
  };
}
