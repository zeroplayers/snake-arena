/**
 * `@zerosnake/house-bots`: the built-in opponents.
 *
 * - `easy`: nearest food, turns back from the wall late. The qualification bar for deploys.
 * - `medium`: best-value food, steers around bodies, heads and the wall.
 * - `hard`: `medium` plus hunting smaller snakes (cuts them off, boosts for the cut).
 * - `chaos`: random but not suicidal.
 *
 * Each is an ordinary `defineBot` module written against `@zerosnake/sdk` only, so it runs in
 * the sandbox like any user bot.
 */
import type { Bot } from "@zerosnake/sdk";
import { chaos } from "./chaos.ts";
import { easy } from "./easy.ts";
import { hard } from "./hard.ts";
import { medium } from "./medium.ts";

export { chaos, easy, hard, medium };

const bots = { easy, medium, hard, chaos };

export type HouseBotName = keyof typeof bots;

/**
 * House bots by name: `houseBots.easy`, `houseBots[name]`. Typed as plain `Bot<object>` so a
 * runner can drive any of them the same way it drives a user bot; import a bot by its own name
 * for its exact memory type.
 */
export const houseBots: Readonly<Record<HouseBotName, Bot<object>>> = bots;

/** Names ordered from weakest to strongest (`chaos` has no rank and is left out). */
export const RANKED: readonly HouseBotName[] = ["easy", "medium", "hard"];
