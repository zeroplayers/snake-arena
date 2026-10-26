import type { LogFn } from "./log";
import type { BotAction, BotInfo, BotState } from "./types";

/**
 * A bot: optional `init` at the start of each life, then `tick` once per simulation tick.
 *
 * @typeParam M - Your memory type, inferred from what `init` returns.
 */
export interface Bot<M extends object = Record<string, never>> {
  /**
   * Called once at the start of every life, before the first `tick`. Return the memory object
   * that will be passed to every `tick` of this life. Memory is NOT kept between lives.
   * Defaults to returning `{}`.
   */
  init?(info: BotInfo): M;
  /**
   * Called every tick. Must be quick: it runs under an operation budget
   * ({@link BotInfo.opBudget}); going over reuses your previous action and earns a strike.
   * Throwing 3 ticks in a row kills the snake.
   *
   * @param state - What you see this tick. Fresh object every tick; don't keep references.
   * @param mem - The object `init` returned. Mutate it in place to remember things.
   * @param log - Debug output, shown in traces and `zerosnake sim`. Capped per tick.
   * @returns The action for this tick.
   */
  tick(state: BotState, mem: M, log: LogFn): BotAction;
}

/**
 * Declares a bot. Make it the default export of your bot module:
 *
 * ```ts
 * import { defineBot, nearestFood, steerToward } from "@zerosnake/sdk";
 *
 * export default defineBot({
 *   init(info) {
 *     return { mode: "farm" as "farm" | "flee" };
 *   },
 *   tick(state, mem, log) {
 *     const food = nearestFood(state);
 *     if (!food) return { turn: 0 };
 *     log("chasing", food.x, food.y);
 *     return { turn: steerToward(state.self, food) };
 *   },
 * });
 * ```
 *
 * It only returns its argument; its job is to give you type inference for `state`, `mem`
 * and the return value.
 */
export function defineBot<M extends object = Record<string, never>>(bot: Bot<M>): Bot<M> {
  return bot;
}
