import { createFileRoute } from "@tanstack/react-router";
import { getCliApi } from "../../server/env";

// CLI API (CLI token only): create a bot.
export const Route = createFileRoute("/api/bots")({
  server: {
    handlers: {
      POST: ({ request }) => getCliApi().createBot(request),
    },
  },
});
