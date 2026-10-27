import { createFileRoute } from "@tanstack/react-router";
import { getAccount } from "../../../../../server/env";

// Web session only: a version's bundle or source archive, for its owner (the data export links here).
export const Route = createFileRoute("/api/account/files/$versionId/$kind")({
  server: {
    handlers: {
      GET: ({ request, params }) => getAccount().file(request, params.versionId, params.kind),
    },
  },
});
