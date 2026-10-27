import { buildBotInfo, buildBotState } from "@zerosnake/engine";
import { type HouseBotName, houseBots } from "@zerosnake/house-bots";
import { LOG_LIMIT_BYTES } from "@zerosnake/sdk";
import {
  BroadcastSource,
  type LiveBot,
  LiveEngineSource,
  type MatchSource,
} from "@zerosnake/viewer";
import { SHOWCASE_PATH } from "../../site";

export interface HeroSource {
  readonly source: MatchSource;
  /** A real room's broadcast, rather than the local fallback. */
  readonly live: boolean;
}

export interface HeroSourceOptions {
  /** Seed of the local match. */
  readonly seed?: number;
  /** Opens the live showcase; rejects when there is none. Default: `connectShowcase`. */
  readonly live?: () => Promise<MatchSource>;
}

/**
 * What the landing page's arena plays: the live showcase (#27), a real room broadcast in real
 * time, when one is running; otherwise a match between the house bots, simulated in the page by
 * the real engine. The hero plays either from its newest tick (`heroPlayer.ts`).
 */
export async function createHeroSource(options: HeroSourceOptions = {}): Promise<HeroSource> {
  try {
    return { source: await (options.live ?? connectShowcase)(), live: true };
  } catch {
    // No showcase room right now, no WebSocket, or a network that blocks it.
  }
  return { source: await localMatch(options.seed), live: false };
}

/** How long the hero waits for the showcase's first keyframe before playing a local match. */
export const SHOWCASE_TIMEOUT_MS = 4000;

/** The showcase room's broadcast through this site (`src/server/showcase.ts`). */
export function connectShowcase(): Promise<MatchSource> {
  if (typeof WebSocket === "undefined" || typeof location === "undefined") {
    return Promise.reject(new Error("no WebSocket here"));
  }
  const url = new URL(SHOWCASE_PATH, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return BroadcastSource.open({
    connect: () => new WebSocket(url),
    timeoutMs: SHOWCASE_TIMEOUT_MS,
    title: "Live from the arena",
    // The hero never scrubs back.
    maxTicks: 300,
  });
}

async function localMatch(seed = Math.floor(Math.random() * 2 ** 31)): Promise<MatchSource> {
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
