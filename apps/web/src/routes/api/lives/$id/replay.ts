import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { getDb } from "../../../../server/env";
import { replayResponse } from "../../../../server/replay-api";

// Public: the chunk a life died in, for the replay player; 410 once the replay expired (#78).
export const Route = createFileRoute("/api/lives/$id/replay")({
  server: {
    handlers: {
      GET: ({ params }) => replayResponse(getDb(), env.REPLAYS, params.id),
    },
  },
});
