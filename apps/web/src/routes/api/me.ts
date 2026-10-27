import { createFileRoute } from "@tanstack/react-router";
import { getCliApi } from "../../server/env";

// CLI API (CLI token only): who is signed in, their bots and today's deploy quota.
export const Route = createFileRoute("/api/me")({
  server: {
    handlers: {
      GET: ({ request }) => getCliApi().me(request),
    },
  },
});
