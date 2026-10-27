/**
 * The Worker's entry (wrangler.jsonc `main`). Requests go through the edge checks
 * (`src/server/edge.ts`: rate limits, request log, metrics) into TanStack Start; the Cron
 * Trigger runs the arena liveness check (`src/server/liveness.ts`).
 */
import handler from "@tanstack/react-start/server-entry";
import { handleEdge } from "./server/edge";
import { getRateLimiter } from "./server/env";
import { runLivenessCheck } from "./server/liveness";

export default {
  fetch(request, env) {
    return handleEdge(request, env, getRateLimiter(), async (r) => handler.fetch(r));
  },

  scheduled(controller, env, ctx) {
    ctx.waitUntil(runLivenessCheck(env, new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;
