import { createFileRoute } from "@tanstack/react-router";
import { getAccount } from "../../../server/env";

// Web session only: "Download my data" on /settings, one JSON file (src/server/account.ts).
export const Route = createFileRoute("/api/account/export")({
  server: {
    handlers: {
      GET: ({ request }) => getAccount().exportData(request),
    },
  },
});
