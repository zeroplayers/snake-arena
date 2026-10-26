import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import type { Health } from "../../lib/api";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: () => Response.json({ ok: true, environment: env.ENVIRONMENT } satisfies Health),
    },
  },
});
