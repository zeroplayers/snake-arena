import { createFileRoute } from "@tanstack/react-router";
import { getCliApi } from "../../../../server/env";

// CLI API (CLI token only): a life's trace, for the owner of its bot (#25).
export const Route = createFileRoute("/api/lives/$id/trace")({
  server: {
    handlers: {
      GET: ({ request, params }) => getCliApi().getTrace(request, params.id),
    },
  },
});
