import { createFileRoute } from "@tanstack/react-router";
import { getCliApi } from "../../../../server/env";

// CLI API (CLI token only): deploy a new version (`zerosnake deploy`).
export const Route = createFileRoute("/api/bots/$bot/versions")({
  server: {
    handlers: {
      POST: ({ request, params }) => getCliApi().deploy(request, params.bot),
    },
  },
});
