import { buildBotInfo, buildBotState } from "@zerosnake/engine";
import { type HouseBotName, houseBots } from "@zerosnake/house-bots";
import { LOG_LIMIT_BYTES } from "@zerosnake/sdk";
import {
  BroadcastSource,
  type BroadcastStatus,
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

export type LiveStatusListener = (status: BroadcastStatus, failures: number) => void;

export interface HeroSourceOptions {
  /** Seed of the local match. */
  readonly seed?: number;
  /**
   * Opens the live showcase, telling `onStatus` how it goes; rejects when there is none.
   * Default: `connectShowcase`.
   */
  readonly live?: (onStatus: LiveStatusListener) => Promise<MatchSource>;
  /**
   * The live showcase was lost after it played (`watchLive`): the page should switch to
   * `localHeroSource`. Without it, a lost showcase keeps reconnecting.
   */
  readonly onLiveLost?: () => void;
}

/**
 * What the landing page's arena plays: the live showcase (#27), a real room broadcast in real
 * time, when one is running; otherwise a match between the house bots, simulated in the page by
 * the real engine. The hero plays either from its newest tick (`heroPlayer.ts`).
 */
export async function createHeroSource(options: HeroSourceOptions = {}): Promise<HeroSource> {
  const onStatus = options.onLiveLost ? watchLive(options.onLiveLost) : () => {};
  try {
    return { source: await (options.live ?? connectShowcase)(onStatus), live: true };
  } catch {
    // No showcase room right now, no WebSocket, or a network that blocks it.
  }
  return localHeroSource(options.seed);
}

/** The local house-bot match, e.g. once the live showcase was lost. */
export async function localHeroSource(seed?: number): Promise<HeroSource> {
  return { source: await localMatch(seed), live: false };
}

/** How long the hero waits for the showcase's first keyframe before playing a local match. */
export const SHOWCASE_TIMEOUT_MS = 4000;
/** Once live, how long the hero waits for it to come back before playing a local match. */
export const LIVE_LOST_MS = 10_000;
/** Once live, failed reconnects in a row after which the hero plays a local match. */
export const LIVE_LOST_FAILURES = 3;

/**
 * A status listener that calls `onLost` once a showcase that played is gone: `afterFailures`
 * reconnects in a row failed (the showcase closed, the route answers 503), or it hasn't been live
 * for `afterMs`. A suspended source (the hero hidden) isn't lost, however long; it's watched again
 * from its `resume`.
 */
export function watchLive(
  onLost: () => void,
  afterMs = LIVE_LOST_MS,
  afterFailures = LIVE_LOST_FAILURES,
): LiveStatusListener {
  let wasLive = false;
  let lost = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const lose = () => {
    stop();
    if (lost) return;
    lost = true;
    onLost();
  };
  return (status, failures) => {
    if (lost) return;
    if (status === "live") wasLive = true;
    // Opening is `createHeroSource`'s to give up on.
    if (!wasLive) return;
    if (status === "live" || status === "suspended" || status === "closed") stop();
    else if (failures >= afterFailures) lose();
    else timer ??= setTimeout(lose, afterMs);
  };
}

/**
 * Keeps a live showcase connected only while the hero is watched (`watching`: on screen, tab
 * visible, not paused): an idle page must not keep a room in real time. Other sources ignore it.
 */
export function holdLive(source: MatchSource, watching: boolean): void {
  if (!(source instanceof BroadcastSource)) return;
  if (watching) source.resume();
  else source.suspend();
}

/** The showcase room's broadcast through this site (`src/server/showcase.ts`). */
export function connectShowcase(onStatus?: LiveStatusListener): Promise<MatchSource> {
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
    ...(onStatus && { onStatus }),
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
