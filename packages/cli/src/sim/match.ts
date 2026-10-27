import {
  type ActionMap,
  buildBotInfo,
  buildBotState,
  createWorld,
  type DeathCause,
  type FaultMap,
  ReplayRecorder,
  type Snake,
  TICK_RATE,
  type World,
} from "@zerosnake/engine";
import {
  type BotLife,
  createSandbox,
  DEFAULT_OP_BUDGET,
  type Death,
  type Sandbox,
  type TickReport,
} from "@zerosnake/sandbox";
import {
  type Bot,
  type BotAction,
  type BotInfo,
  type BotState,
  createTickLog,
  LOG_LIMIT_BYTES,
} from "@zerosnake/sdk";
import type { MatchInfo } from "@zerosnake/viewer";
import type { SimChunk, SimLife, SnakeCall, TickCalls } from "./protocol.ts";

/**
 * A bot in the lineup: a `bundle` the sandbox runs, as the arena runs every bot (house bots
 * included), or a trusted `bot` object run directly in Node. `sim` uses the latter only for
 * house bots and only with `--native-house`: about 4× faster, but not exactly the arena, since
 * QuickJS and V8 may round `Math.sin`/`atan2` differently and native bots report no op counts.
 */
export type Contestant = ContestantBase & ({ bundle: string } | { bot: Bot<object> });

interface ContestantBase {
  /** Shown in the viewer; lives get ids `name#1`, `name#2`, … Unique within a match. */
  name: string;
  /** The bot under development. */
  you?: boolean;
}

export interface MatchOptions {
  contestants: readonly Contestant[];
  seed: number;
  /** Ticks to simulate. */
  ticks: number;
  /** Shared by every bot, as in a room. Created (and dropped) by the match when omitted. */
  sandbox?: Sandbox;
  /** Ticks between a death and that bot's next life. Default 20. */
  respawnDelay?: number;
  /** Ticks per replay chunk sent to the viewer. Default 100 (10 s of game time). */
  chunkTicks?: number;
  /** Each finished chunk, with every life so far. */
  onChunk?: (chunk: SimChunk, lives: readonly SimLife[]) => void;
  /** Hand the event loop back after each chunk (so a server can answer while the match runs). */
  yieldBetweenChunks?: boolean;
  /** Stops the match early (checked between chunks); the result covers the ticks run so far. */
  signal?: AbortSignal;
  title?: string;
}

/** A bot call that didn't go cleanly, kept for the summary. */
export interface CallProblem {
  tick: number;
  life: string;
  message: string;
}

export interface BotSummary {
  name: string;
  you: boolean;
  lives: number;
  /** Sum of life scores; a life still running at the end counts with its score so far. */
  totalScore: number;
  meanScore: number;
  bestScore: number;
  kills: number;
  /** Lives that ended, by cause. */
  deaths: Partial<Record<DeathCause, number>>;
  calls: number;
  /** Highest op count of one call; the budget is `opBudget`. */
  maxOps: number;
  /** Calls over the op budget (each one a strike). */
  overBudget: number;
  /** Calls that threw. */
  errors: number;
  firstOverBudget: CallProblem | null;
  firstError: CallProblem | null;
}

export interface MatchResult {
  seed: number;
  ticks: number;
  opBudget: number;
  info: MatchInfo;
  lives: SimLife[];
  bots: BotSummary[];
}

type MutableLife = { -readonly [K in keyof SimLife]: SimLife[K] };

interface Slot {
  readonly contestant: Contestant;
  readonly summary: BotSummary;
  lives: number;
  respawnAt: number;
}

/** What a tick needs from a life: a sandbox `BotLife`, or a trusted bot run in Node. */
type Life = Pick<BotLife, "tick" | "dispose" | "loadLog">;

interface Running {
  readonly slot: Slot;
  readonly life: Life;
  readonly record: MutableLife;
  /** `log()` output of module evaluation and `init()`, shown with the first call. */
  pendingLog: string[];
  verdict: Death | null;
}

/**
 * Runs a local match the way a room does: every `bundle` bot in one shared QuickJS sandbox with
 * the production op budget, memory limit and strike rules, one sandbox life per snake life, and
 * sandbox verdicts passed to the engine as faults (`bot` contestants run in Node with the same
 * error rule). Dead bots respawn as new lives.
 * The match is recorded as engine replay chunks plus each bot call's ops and logs.
 */
export async function runMatch(options: MatchOptions): Promise<MatchResult> {
  const names = new Set<string>();
  for (const c of options.contestants) {
    if (names.has(c.name)) throw new Error(`two bots are named ${c.name}`);
    names.add(c.name);
  }
  const needsSandbox = options.contestants.some((c) => "bundle" in c);
  const sandbox = options.sandbox ?? (needsSandbox ? await createSandbox() : null);
  const respawnDelay = options.respawnDelay ?? 20;
  const opBudget = DEFAULT_OP_BUDGET;
  const limits = { opBudget, logLimitBytes: LOG_LIMIT_BYTES };

  const world = createWorld({ seed: options.seed });
  const info = matchInfo(world, options.title ?? defaultTitle(options.seed));
  const lives: MutableLife[] = [];
  const running = new Map<string, Running>();
  const slots: Slot[] = options.contestants.map((contestant) => ({
    contestant,
    summary: emptySummary(contestant),
    lives: 0,
    respawnAt: 0,
  }));

  let pendingCalls: TickCalls[] = [];
  const recorder = new ReplayRecorder(world, {
    chunkTicks: options.chunkTicks ?? 100,
    onChunk: (bytes, chunk) => {
      const calls = pendingCalls.slice(0, chunk.ticks.length);
      pendingCalls = pendingCalls.slice(chunk.ticks.length);
      options.onChunk?.({ bytes, calls }, lives);
    },
  });

  const spawnDue = (): void => {
    for (const slot of slots) {
      const busy = [...running.values()].some((r) => r.slot === slot);
      if (busy || world.tick < slot.respawnAt) continue;
      slot.lives++;
      slot.summary.lives++;
      const id = `${slot.contestant.name}#${slot.lives}`;
      const snake = recorder.spawn({ id, author: slot.contestant.name });
      const info = buildBotInfo(world, snake, limits);
      const c = slot.contestant;
      const life =
        "bot" in c ? nativeLife(c.bot, info) : (sandbox as Sandbox).startLife(c.bundle, info);
      const record: MutableLife = {
        id,
        bot: slot.contestant.name,
        author: slot.contestant.name,
        bornTick: world.tick,
        you: slot.contestant.you === true,
      };
      lives.push(record);
      running.set(id, {
        slot,
        life,
        record,
        pendingLog: life.loadLog.lines.map((l) => `[init] ${l}`),
        verdict: null,
      });
    }
  };

  try {
    spawnDue();
    let lastChunkTick = 0;
    while (world.tick < options.ticks && !options.signal?.aborted) {
      const actions: Record<string, { turn: number; boost: boolean }> = {};
      const faults: Record<string, "timeout" | "error"> = {};
      const calls: TickCalls = {};
      for (const snake of world.snakes) {
        const run = running.get(snake.id);
        if (!run) continue;
        const report: LifeReport = run.life.tick(buildBotState(world, snake));
        actions[snake.id] = { turn: report.action.turn, boost: report.action.boost === true };
        if (report.death) {
          faults[snake.id] = report.death.fault;
          run.verdict = report.death;
        }
        calls[snake.id] = toCall(run, report, opBudget);
        account(run, report, world.tick, snake);
      }
      pendingCalls.push(calls);
      recorder.step(actions as ActionMap, faults as FaultMap);
      settleDeaths(world, running, respawnDelay);
      spawnDue();
      if (options.yieldBetweenChunks && world.tick - lastChunkTick >= (options.chunkTicks ?? 100)) {
        lastChunkTick = world.tick;
        await new Promise((r) => setImmediate(r));
      }
    }
    recorder.flush();
  } finally {
    for (const run of running.values()) run.life.dispose();
  }

  // Lives still running count with their score so far.
  for (const snake of world.snakes) {
    const slot = running.get(snake.id)?.slot;
    if (slot) addScore(slot.summary, snake.score);
  }
  for (const slot of slots) {
    const s = slot.summary;
    s.meanScore = s.lives > 0 ? s.totalScore / s.lives : 0;
  }
  return {
    seed: options.seed,
    ticks: world.tick,
    opBudget,
    info,
    lives,
    bots: slots.map((s) => s.summary),
  };
}

/** What the viewer needs to know about a match before its first tick. */
export function matchInfo(world: World, title: string): MatchInfo {
  return {
    tps: TICK_RATE,
    arenaRadius: world.config.arenaRadius,
    visionRadius: world.config.visionRadius,
    title,
  };
}

export function defaultTitle(seed: number): string {
  return `Local match · seed ${seed}`;
}

function settleDeaths(world: World, running: Map<string, Running>, respawnDelay: number): void {
  for (const d of world.deaths) {
    const run = running.get(d.id);
    if (!run) continue;
    run.record.death = {
      tick: d.tick,
      cause: d.cause,
      killerId: d.killerId,
      score: d.score,
      mass: d.mass,
      kills: d.kills,
      ...(run.verdict && { sandbox: { reason: run.verdict.reason, message: run.verdict.message } }),
    };
    const s = run.slot.summary;
    addScore(s, d.score);
    s.kills += d.kills;
    s.deaths[d.cause] = (s.deaths[d.cause] ?? 0) + 1;
    run.slot.respawnAt = world.tick + respawnDelay;
    run.life.dispose();
    running.delete(d.id);
  }
}

function toCall(run: Running, report: LifeReport, opBudget: number): SnakeCall {
  const lines =
    run.pendingLog.length > 0 ? [...run.pendingLog, ...report.log.lines] : report.log.lines;
  run.pendingLog = [];
  const notes: string[] = [];
  if (report.death) {
    notes.push(`⚠ sandbox: ${describeVerdict(report.death)}`);
  } else if (report.outcome === "timeout") {
    notes.push(`⚠ over the op budget (${report.interrupts}/${opBudget}), strike ${report.strikes}`);
  } else if (report.outcome === "error") {
    notes.push(`⚠ threw (${report.errors} in a row): ${report.error}`);
  }
  const all = notes.length > 0 ? [...lines, ...notes] : lines;
  return {
    ...(report.native !== true && { o: report.interrupts }),
    a: report.action.turn,
    ...(report.action.boost === true && { b: 1 as const }),
    ...(all.length > 0 && { l: all }),
    ...(report.log.truncated && { t: 1 as const }),
  };
}

function account(run: Running, report: LifeReport, tick: number, snake: Snake): void {
  const s = run.slot.summary;
  s.calls++;
  s.maxOps = Math.max(s.maxOps, report.interrupts);
  if (report.outcome === "timeout") {
    s.overBudget++;
    s.firstOverBudget ??= {
      tick,
      life: snake.id,
      message: report.error ?? "over the op budget",
    };
  } else if (report.outcome === "error") {
    s.errors++;
    s.firstError ??= { tick, life: snake.id, message: report.error ?? "unknown error" };
  }
}

/** A sandbox report, or the same shape from a bot run in Node (`native`: no op count). */
type LifeReport = TickReport & { native?: true };

const MAX_NATIVE_ERRORS = 3;

/** Runs a trusted bot in Node with the sandbox's error rule (3 throws in a row: death). */
function nativeLife(bot: Bot<object>, info: BotInfo): Life {
  const log = createTickLog(info.logLimitBytes);
  let mem: object = {};
  let last: BotAction = { turn: 0 };
  let errors = 0;
  let death: Death | null = null;
  try {
    mem = bot.init?.(info) ?? {};
  } catch (e) {
    death = { fault: "error", reason: "load", message: `init() threw: ${errorText(e)}` };
  }
  const loadLog = log.flush();
  return {
    loadLog,
    dispose() {},
    tick(state: BotState): LifeReport {
      let outcome: TickReport["outcome"] = "ok";
      let error: string | null = death?.message ?? null;
      if (!death) {
        try {
          last = bot.tick(state, mem, log.log);
          errors = 0;
        } catch (e) {
          outcome = "error";
          error = errorText(e);
          errors++;
          if (errors >= MAX_NATIVE_ERRORS) {
            death = {
              fault: "error",
              reason: "errors",
              message: `${errors} ticks in a row threw; last: ${error}`,
            };
          }
        }
      }
      return {
        action: last,
        outcome: death ? "error" : outcome,
        error,
        interrupts: 0,
        work: 0,
        log: log.flush(),
        strikes: 0,
        errors,
        death,
        native: true,
      };
    },
  };
}

function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function addScore(s: BotSummary, score: number): void {
  s.totalScore += score;
  s.bestScore = Math.max(s.bestScore, score);
}

function emptySummary(c: Contestant): BotSummary {
  return {
    name: c.name,
    you: c.you === true,
    lives: 0,
    totalScore: 0,
    meanScore: 0,
    bestScore: 0,
    kills: 0,
    deaths: {},
    calls: 0,
    maxOps: 0,
    overBudget: 0,
    errors: 0,
    firstOverBudget: null,
    firstError: null,
  };
}

/** A sandbox death in plain language, in one line. */
export function describeVerdict(death: Pick<Death, "reason" | "message">): string {
  switch (death.reason) {
    case "timeouts":
      return `too slow: ${death.message}`;
    case "errors":
      return `kept crashing: ${death.message}`;
    case "oom":
      return `ran out of memory: ${death.message}`;
    case "load":
      return `failed to load: ${death.message}`;
    case "crash":
      return `the sandbox failed while running it: ${death.message}`;
  }
}

/** What to do about a kind of sandbox death; printed once under the lives. */
export function verdictHint(reason: Death["reason"], opBudget: number = DEFAULT_OP_BUDGET): string {
  switch (reason) {
    case "timeouts":
      return `A tick may use ${opBudget} ops (one op is roughly 10 000 JS operations). Do less per tick, or spread work over ticks with \`mem\`.`;
    case "errors":
      return "Three throws in a row kill the snake. The viewer shows the error and your log() lines on each tick before it.";
    case "oom":
      return "A bot gets 8 MB. Keep `mem` small: cap arrays and maps you add to every tick.";
    case "load":
      return "Loading runs your module's top level and init() under a budget of 100 ops.";
    case "crash":
      return "This is a sandbox problem rather than your bot's; please report it with the seed.";
  }
}
