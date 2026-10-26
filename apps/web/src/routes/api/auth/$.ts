import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "../../../server/env";

// Better Auth: GitHub OAuth, sessions, username, device flow and CLI tokens under /api/auth/*.
export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => getAuth().handler(request),
      POST: ({ request }) => getAuth().handler(request),
    },
  },
});
