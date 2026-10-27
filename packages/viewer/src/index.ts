/**
 * `@zerosnake/viewer`: the match viewer used by `zerosnake sim` and the site.
 *
 *   const source = new LiveEngineSource({ bots, seed: 42 });
 *   const viewer = mountViewer(document.getElementById("app")!, source);
 *
 * The viewer only talks to a `MatchSource`; a replay player implements the same interface, and
 * `BroadcastSource` plays a room's live broadcast (`followLive` keeps it behind the live edge).
 */

export { foodDisplaySize, REMAINS_DISPLAY_SCALE } from "./food.ts";
export {
  type LifeState,
  type LogEntry,
  lifeAt,
  pickSnake,
  ranking,
  recentDeaths,
  recentLogs,
} from "./inspect.ts";
export {
  BroadcastSource,
  type BroadcastSourceOptions,
  type BroadcastStatus,
  DEFAULT_LIVE_DELAY,
  followLive,
} from "./live/BroadcastSource.ts";
export {
  DEFAULT_VISION_RADIUS,
  type LiveBot,
  LiveEngineSource,
  type LiveSourceOptions,
} from "./live/LiveEngineSource.ts";
export { mountViewer, type ViewerHandle, type ViewerOptions } from "./mountViewer.ts";
export { DEATH_LEAD_TICKS, Playback, type PlaybackSample, SPEEDS } from "./Playback.ts";
export type {
  BotTrace,
  LifeDeath,
  LifeInfo,
  MatchInfo,
  MatchSource,
  SnakeTick,
  TickSnapshot,
} from "./types.ts";
