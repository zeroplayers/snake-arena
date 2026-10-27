/**
 * `GET /api/lives/:id/replay` (public, like the replay page): the chunk the life died in and who
 * played in it (`ReplayResponse`), for the site's replay player and anyone else. Errors are
 * `ApiErrorBody`s: 404 `life_not_found` / `replay_not_found`, 410 `replay_expired` once the
 * replay retention deleted the chunk (`src/shared/replay.ts`).
 */
import type { Db } from "../db";
import { readLifeReplay } from "../queries/replay";
import {
  REPLAY_EXPIRED_MESSAGE,
  type ReplayErrorBody,
  type ReplayResponse,
} from "../shared/replay";

function json(body: ReplayResponse | ReplayErrorBody, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function replayResponse(db: Db, bucket: R2Bucket, lifeId: string): Promise<Response> {
  const read = await readLifeReplay(db, bucket, lifeId);
  switch (read.status) {
    case "ok":
      return json(read.replay);
    case "not_found":
      return json({ error: "life_not_found", message: `There is no life "${lifeId}".` }, 404);
    case "none":
      return json(
        { error: "replay_not_found", message: "No recording was kept for this life." },
        404,
      );
    case "expired":
      return json({ error: "replay_expired", message: REPLAY_EXPIRED_MESSAGE }, 410);
  }
}
