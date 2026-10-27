/**
 * Replay retention (#78). Rooms record their replays in R2 `REPLAYS` as chunks of about two
 * minutes (`<roomId>/<start tick, 10 digits>.zsr`, apps/arena `room/sim.ts`), each opening with a
 * world snapshot, so one plays without the chunks before it. A life's replay page plays the chunk
 * it died in (`lives.replay_key`).
 *
 * Chunks are kept {@link REPLAY_RETENTION_DAYS} days. Older ones are kept only while a pinned
 * life needs them, every chunk from the one it was born in to the one it died in:
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
 * `GET /api/lives/:id/replay` (public): the chunk the life died in and who played in it. Errors:
 * 404 `life_not_found` / `replay_not_found`, 410 `replay_expired`.
 */
export interface ReplayResponse {
  /** Encoded `ReplayChunk` (`@zerosnake/engine`), base64. */
  chunk: string;
  participants: ReplayParticipant[];
}

export type ReplayErrorBody = ApiErrorBody & {
  error: "life_not_found" | "replay_not_found" | "replay_expired";
};
