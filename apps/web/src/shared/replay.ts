/**
 * Replay retention (#78). Rooms record their replays in R2 `REPLAYS` as chunks of about two
 * minutes (`<roomId>/<start tick, 10 digits>.zsr`, apps/arena `room/sim.ts`), each opening with a
 * world snapshot, so one plays without the chunks before it. A life's replay is a window: the
 * chunks covering its last {@link REPLAY_WINDOW_TICKS} ticks (10 minutes of game time), ending
 * with the one it died in (`lives.replay_key`). Lives last until the snake dies, up to 24 hours
 * (720 chunks), so a replay never loads a whole life.
 *
 * Chunks are kept {@link REPLAY_RETENTION_DAYS} days. Older ones are kept only while a pinned
 * life needs them, the chunks of its replay window:
 * - the {@link REPLAY_PINNED_TOP_LIVES} best lives (by score) whose replay is still there;
 * - the {@link REPLAY_PINNED_LIVES_PER_BOT} best lives of each of the
 *   {@link REPLAY_PINNED_TOP_BOTS} first bots of the leaderboard, over all their versions.
 *
 * apps/web's cron deletes the rest (`src/server/replays.ts`) and sets `lives.replay_expired_at`
 * on the lives whose chunk it deleted: their page says the replay is no longer available, and
 * `GET /api/lives/:id/replay` answers 410 `replay_expired`.
 */
import type { ApiErrorBody } from "./deploy";

export const REPLAY_RETENTION_DAYS = 2;
/**
 * A life's replay shows (and retention keeps for a pinned life) its last this many ticks before
 * its end: 10 minutes of game time, at most 6 chunks of 1200. A shorter life plays from birth.
 */
export const REPLAY_WINDOW_TICKS = 6000;
/** Most chunks one replay loads (the window's 5 full chunks and a partial one, plus slack). */
export const REPLAY_WINDOW_MAX_CHUNKS = 8;
/** Best lives of all time whose replays are kept. */
export const REPLAY_PINNED_TOP_LIVES = 100;
/** Leaderboard bots whose best lives' replays are kept. */
export const REPLAY_PINNED_TOP_BOTS = 20;
/** Best lives kept per leaderboard bot. */
export const REPLAY_PINNED_LIVES_PER_BOT = 5;

/** Said wherever an expired replay would have been. */
export const REPLAY_EXPIRED_MESSAGE = `This replay is no longer available. Replays are kept ${REPLAY_RETENTION_DAYS} days, except for the best lives.`;

/** A life the viewer shows a replay of, by engine snake id (= `lives.id`). */
export interface ReplayParticipant {
  id: string;
  author: string;
  botName: string;
  botSlug: string;
  version: number;
}

/**
 * `GET /api/lives/:id/replay` (public): the life's replay window and who played in it. Errors:
 * 404 `life_not_found` / `replay_not_found`, 410 `replay_expired`.
 */
export interface ReplayResponse {
  /**
   * Encoded `ReplayChunk`s (`@zerosnake/engine`), base64, consecutive and oldest first: the
   * chunks covering the life's last `REPLAY_WINDOW_TICKS` ticks, the last one the chunk it died
   * in. Fewer when earlier ones are gone (retention deletes oldest first), never none.
   */
  chunks: string[];
  participants: ReplayParticipant[];
}

/** R2 key (`REPLAYS`) of the chunk of room `roomId` that starts at `tick`. */
export function replayChunkKey(roomId: string, tick: number): string {
  return `${roomId}/${String(tick).padStart(10, "0")}.zsr`;
}

/** A chunk key's room prefix (`<roomId>/`) and start tick, or null for any other key. */
export function parseChunkKey(key: string): { room: string; tick: number } | null {
  const match = /^(.+\/)(\d+)\.zsr$/.exec(key);
  if (!match) return null;
  return { room: match[1] as string, tick: Number(match[2]) };
}

/**
 * The first tick of a life's replay window: its last `REPLAY_WINDOW_TICKS` ticks, or all of it
 * when it was shorter.
 */
export function replayWindowStart(startTick: number, endTick: number): number {
  return Math.max(startTick, endTick - REPLAY_WINDOW_TICKS);
}

export type ReplayErrorBody = ApiErrorBody & {
  error: "life_not_found" | "replay_not_found" | "replay_expired";
};
