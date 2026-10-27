import { createFileRoute } from "@tanstack/react-router";
import { getCliApi } from "../../../../../../server/env";

// CLI API (CLI token only): a version's finished lives, latest first.
export const Route = createFileRoute("/api/bots/$bot/versions/$n/lives")({
  server: {
    handlers: {
      GET: ({ request, params }) => getCliApi().listLives(request, params.bot, params.n),
    },
  },
});
