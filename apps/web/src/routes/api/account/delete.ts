import { createFileRoute } from "@tanstack/react-router";
import { getAccount } from "../../../server/env";

// Web session only, from the site's origin: "Delete my account" on /settings (src/server/account.ts).
export const Route = createFileRoute("/api/account/delete")({
  server: {
    handlers: {
      POST: ({ request }) => getAccount().deleteAccount(request),
    },
  },
});
