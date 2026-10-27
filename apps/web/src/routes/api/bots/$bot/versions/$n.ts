import { createFileRoute } from "@tanstack/react-router";
import { getCliApi } from "../../../../../server/env";

// CLI API (CLI token only): a version's status and check report.
export const Route = createFileRoute("/api/bots/$bot/versions/$n")({
  server: {
    handlers: {
      GET: ({ request, params }) => getCliApi().getVersion(request, params.bot, params.n),
    },
  },
});
