/**
 * Real engine matches between house bots, for the strength-ordering test and
 * `scripts/bench.ts`. Not exported from the package: it needs `@zerosnake/engine`, which is only
 * a dev dependency.
 */
import {
  type Action,
  buildBotInfo,
  buildBotState,
  createWorld,
  type Snake,
  spawnSnake,
  step,
} from "@zerosnake/engine";
import { type BotAction, createTickLog, LOG_LIMIT_BYTES } from "@zerosnake/sdk";
import { type HouseBotName, houseBots } from "./index.ts";

export interface MatchOptions {
  seed: number;
  /** One snake slot per entry, e.g. `["easy", "medium", "hard", "easy", "medium", "hard"]`. */
  lineup: readonly HouseBotName[];
  ticks: number;
}

/** One snake slot over a whole match: it respawns as the same bot after every death. */
export interface SlotResult {
  bot: HouseBotName;
  /** Lives started (the one alive at the end included). */
  lives: number;
  /** Lives ended by a collision or the wall (not retirement). */
  deaths: number;
  /** Of those, how many hit the wall. */
  wallDeaths: number;
  /** Sum of the scores of all its lives, the one alive at the end included. */
  score: number;
}

/**
 * Runs one match the way a room does: every snake is driven by its bot on the state of the
 * frame before `step`, and a slot respawns right after each death. Fully deterministic for a
 * given seed and lineup.
 */
export function runMatch({ seed, lineup, ticks }: MatchOptions): SlotResult[] {
  const world = createWorld({ seed });
  const { log } = createTickLog();
  const slots: SlotResult[] = lineup.map((bot) => ({
    bot,
    lives: 0,
    deaths: 0,
    wallDeaths: 0,
    score: 0,
  }));
  const memory = new Map<string, object>();

  const spawn = (slot: number) => {
    const result = slots[slot] as SlotResult;
    const id = String(slot);
    const snake: Snake = spawnSnake(world, { id, author: result.bot });
    const info = buildBotInfo(world, snake, { opBudget: 0, logLimitBytes: LOG_LIMIT_BYTES });
    memory.set(id, houseBots[result.bot].init?.(info) ?? {});
    result.lives++;
  };
  for (let slot = 0; slot < lineup.length; slot++) spawn(slot);

  for (let t = 0; t < ticks; t++) {
    const actions: Record<string, Action> = {};
    for (const snake of world.snakes) {
      const bot = houseBots[(slots[Number(snake.id)] as SlotResult).bot];
      const action: BotAction = bot.tick(
        buildBotState(world, snake),
        memory.get(snake.id) as object,
        log,
      );
      actions[snake.id] = { turn: action.turn, boost: action.boost ?? false };
    }
    step(world, actions);
    for (const death of world.deaths) {
      const slot = Number(death.id);
      const result = slots[slot] as SlotResult;
      result.score += death.score;
      if (death.cause !== "retired") result.deaths++;
      if (death.cause === "wall") result.wallDeaths++;
      spawn(slot);
    }
  }
  for (const snake of world.snakes) (slots[Number(snake.id)] as SlotResult).score += snake.score;
  return slots;
}

export interface BotSummary {
  /** Mean score per snake slot per match: the strength metric (respawning is part of it). */
  perSlot: number;
  /** Mean score per life. Rewards surviving long, but ignores how often a bot dies. */
  perLife: number;
  /** Mean deaths per slot per match. */
  deathsPerSlot: number;
  /** Mean wall deaths per slot per match. */
  wallDeathsPerSlot: number;
}

/** Aggregates match results by bot. */
export function summarize(
  matches: readonly SlotResult[][],
): Partial<Record<HouseBotName, BotSummary>> {
  const acc = new Map<
    HouseBotName,
    { slots: number; lives: number; deaths: number; wallDeaths: number; score: number }
  >();
  for (const match of matches) {
    for (const s of match) {
      const a = acc.get(s.bot) ?? { slots: 0, lives: 0, deaths: 0, wallDeaths: 0, score: 0 };
      a.slots++;
      a.lives += s.lives;
      a.deaths += s.deaths;
      a.wallDeaths += s.wallDeaths;
      a.score += s.score;
      acc.set(s.bot, a);
    }
  }
  const out: Partial<Record<HouseBotName, BotSummary>> = {};
  for (const [bot, a] of acc) {
    out[bot] = {
      perSlot: a.score / a.slots,
      perLife: a.score / a.lives,
      deathsPerSlot: a.deaths / a.slots,
      wallDeathsPerSlot: a.wallDeaths / a.slots,
    };
  }
  return out;
}
