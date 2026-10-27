import { buildBotInfo, buildBotState } from "@zerosnake/engine";
import { type HouseBotName, houseBots } from "@zerosnake/house-bots";
import { LOG_LIMIT_BYTES } from "@zerosnake/sdk";
import { type LiveBot, LiveEngineSource, type MatchSource } from "@zerosnake/viewer";

/**
 * Hook for the live showcase (zeroplayers/snake-arena#27): what the landing page's arena plays.
 *
 * Today it is a match between the house bots, simulated in the page by the real engine. Once the
 * showcase room broadcasts, return a `MatchSource` over that broadcast here instead: the hero
 * plays any source from its newest tick (`ArenaHero` and `heroPlayer.ts` don't change), and
 * `HERO_IS_LIVE` in `heroLive.ts` switches the caption.
 */
export async function createHeroSource(
  seed = Math.floor(Math.random() * 2 ** 31),
): Promise<MatchSource> {
  const source = new LiveEngineSource({
    bots: LINEUP.map((name, i) => houseBot(name, i)),
    seed,
    // A smaller disc than a room's, so snakes read at hero size and meet more often.
    config: { arenaRadius: 38 },
    // The hero never scrubs back; keep only a little history.
    maxTicks: 300,
    title: "House bots",
  });
  // Start mid-fight rather than on the spawn tick, without one long task on slow phones.
  while (source.lastTick < WARM_UP_TICKS) {
    source.request(source.lastTick + 50);
    await new Promise((resolve) => setTimeout(resolve));
  }
  return source;
}

const LINEUP: readonly HouseBotName[] = [
  "hard",
  "medium",
  "hard",
  "chaos",
  "medium",
  "easy",
  "hard",
  "medium",
];

const WARM_UP_TICKS = 300;

/** A house bot driven natively in the page, one `init` per life, as a room runs it. */
function houseBot(name: HouseBotName, slot: number): LiveBot {
  const bot = houseBots[name];
  let life: { id: string; mem: object } | undefined;
  return {
    // Lives are named `<name>#<n>`, so slots of the same bot need their own names.
    name: `${name}-${slot + 1}`,
    author: "house",
    act(snake, world, log) {
      if (life?.id !== snake.id) {
        const info = buildBotInfo(world, snake, { opBudget: 0, logLimitBytes: LOG_LIMIT_BYTES });
        life = { id: snake.id, mem: bot.init?.(info) ?? {} };
      }
      return bot.tick(buildBotState(world, snake), life.mem, log);
    },
  };
}
