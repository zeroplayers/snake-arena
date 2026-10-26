/**
 * A tiny local match runner for tests: the real engine, your bot in the real QuickJS sandbox
 * (same budget as the arena), house bots as opponents. `zerosnake sim` / `zerosnake test` do the
 * same with more checks and a viewer; this is just enough to catch a broken bot in `npm test`.
 */
import { fileURLToPath } from "node:url";
import {
  type ActionMap,
  buildBotInfo,
  buildBotState,
  createWorld,
  type DeathCause,
  type FaultMap,
  spawnSnake,
  step,
} from "@zerosnake/engine";
import { type HouseBotName, houseBots } from "@zerosnake/house-bots";
import { type BotLife, createSandbox, DEFAULT_OP_BUDGET, WORK_PER_OP } from "@zerosnake/sandbox";
import { type BotAction, type BotState, createTickLog, LOG_LIMIT_BYTES } from "@zerosnake/sdk";
import { build } from "esbuild";

const BOT_ENTRY = fileURLToPath(new URL("../src/bot.ts", import.meta.url));
const ME = "me";
const LIMITS = { opBudget: DEFAULT_OP_BUDGET, logLimitBytes: LOG_LIMIT_BYTES };
/** Ticks of your bot's history kept for each life (the arena keeps the last 100 in traces). */
export const TRACE_TICKS = 30;

/** Bundles a bot (default `src/bot.ts`) into one ESM file, the way `zerosnake deploy` does. */
export async function bundleBot(entry: string = BOT_ENTRY): Promise<string> {
  const out = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    write: false,
  });
  return out.outputFiles[0]?.text ?? "";
}

export interface MatchOptions {
  seed: number;
  ticks: number;
  /** House bots to play against; each gets its own snake. */
  opponents?: HouseBotName[];
}

/** One tick of your bot, as it saw and answered it. */
export interface TraceTick {
  tick: number;
  /** Exactly what `tick()` received. */
  state: BotState;
  /** What the engine applied (the previous action if this tick timed out or threw). */
  action: BotAction;
  outcome: "ok" | "timeout" | "error" | "skipped";
  error: string | null;
  interrupts: number;
  log: string[];
}

/** One life: finished, or still `alive` when the match ended. */
export interface Life {
  /** Who played it: `"me"` (your bot) or a house bot's name. */
  bot: string;
  seed: number;
  cause: DeathCause | "alive";
  /** World tick the life ended on (or the match ended on). */
  tick: number;
  lifeTicks: number;
  score: number;
  /** For `collision`: who you hit (`"easy"`, `"hard"`, ...); `null` otherwise. */
  killer: string | null;
  /** Sandbox error message for `error` / `timeout` deaths. */
  error: string | null;
  /** Your bot only: the last {@link TRACE_TICKS} ticks of the life, oldest first. */
  trace: TraceTick[];
}

export interface MatchResult {
  /** Your bot's lives. */
  lives: Life[];
  /** The house bots' lives, for comparison. */
  houseLives: Life[];
  /** Ticks where the bot threw, or ran over its budget (each is also logged in `problems`). */
  errors: number;
  timeouts: number;
  problems: string[];
  /** Most interrupts / native work used by one tick, against `DEFAULT_OP_BUDGET`. */
  maxInterrupts: number;
  maxWork: number;
  /** `log()` output of module load and `init()`, per life. */
  loadLogs: string[];
}

/** Plays one match. Your bot respawns after each death; so do the house bots. */
export async function playMatch(bundle: string, o: MatchOptions): Promise<MatchResult> {
  const sandbox = await createSandbox();
  const world = createWorld({ seed: o.seed });
  const result: MatchResult = {
    lives: [],
    houseLives: [],
    errors: 0,
    timeouts: 0,
    problems: [],
    maxInterrupts: 0,
    maxWork: 0,
    loadLogs: [],
  };

  const me = { life: null as BotLife | null, trace: [] as TraceTick[] };
  const spawnMe = () => {
    const snake = spawnSnake(world, { id: ME, author: "you" });
    const life = sandbox.startLife(bundle, buildBotInfo(world, snake, LIMITS));
    result.loadLogs.push(...life.loadLog.lines);
    if (life.death) result.problems.push(`failed to load: ${life.death.message}`);
    me.life = life;
    me.trace = [];
  };

  const house = new Map<string, { name: HouseBotName; mem: object }>();
  const spawnHouse = (id: string, name: HouseBotName) => {
    const snake = spawnSnake(world, { id, author: "house" });
    const mem = houseBots[name].init?.(buildBotInfo(world, snake, LIMITS)) ?? {};
    house.set(id, { name, mem });
  };

  spawnMe();
  for (const [i, name] of (o.opponents ?? []).entries()) spawnHouse(`${name}-${i}`, name);
  const { log } = createTickLog();

  for (let t = 0; t < o.ticks; t++) {
    const actions: Record<string, ActionMap[string]> = {};
    const faults: Record<string, FaultMap[string]> = {};
    for (const snake of world.snakes) {
      const state = buildBotState(world, snake);
      if (snake.id === ME && me.life) {
        const report = me.life.tick(state);
        actions[ME] = report.action;
        result.maxInterrupts = Math.max(result.maxInterrupts, report.interrupts);
        result.maxWork = Math.max(result.maxWork, report.work);
        me.trace.push({
          tick: world.tick,
          state,
          action: report.action,
          outcome: report.outcome,
          error: report.error,
          interrupts: report.interrupts,
          log: report.log.lines,
        });
        if (me.trace.length > TRACE_TICKS) me.trace.shift();
        if (report.outcome === "error" || report.outcome === "timeout") {
          if (report.outcome === "error") result.errors++;
          else result.timeouts++;
          result.problems.push(`tick ${world.tick}: ${report.outcome}: ${report.error}`);
        }
        if (report.death) faults[ME] = report.death.fault;
        continue;
      }
      const h = house.get(snake.id);
      if (h) actions[snake.id] = houseBots[h.name].tick(state, h.mem, log);
    }

    step(world, actions, faults);

    for (const death of world.deaths) {
      const { cause, tick, lifeTicks, score } = death;
      const killer = death.killerId === null ? null : nameOf(death.killerId);
      const life = { seed: o.seed, cause, tick, lifeTicks, score, killer };
      if (death.id === ME) {
        const error = me.life?.death?.message ?? null;
        result.lives.push({ bot: ME, ...life, error, trace: me.trace });
        me.life?.dispose();
        spawnMe();
      } else {
        const h = house.get(death.id);
        if (!h) continue;
        result.houseLives.push({ bot: h.name, ...life, error: null, trace: [] });
        spawnHouse(death.id, h.name);
      }
    }
  }

  for (const snake of world.snakes) {
    const life = {
      bot: nameOf(snake.id),
      seed: o.seed,
      cause: "alive" as const,
      tick: world.tick,
      lifeTicks: snake.lifeTick,
      score: snake.score,
      killer: null,
      error: null,
    };
    if (snake.id === ME) result.lives.push({ ...life, trace: me.trace });
    else result.houseLives.push({ ...life, trace: [] });
  }
  me.life?.dispose();
  return result;

  function nameOf(id: string): string {
    return id === ME ? ME : (house.get(id)?.name ?? id);
  }
}

/** The per-tick budgets the arena enforces. */
export const BUDGET = { interrupts: DEFAULT_OP_BUDGET, work: DEFAULT_OP_BUDGET * WORK_PER_OP };
