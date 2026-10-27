/**
 * The Worker's entry (wrangler.jsonc `main`). Requests go through the edge checks
 * (`src/server/edge.ts`: rate limits, request log, metrics) into TanStack Start. Cron Triggers
 * (`triggers.crons` in wrangler.jsonc) run the rating job every minute (`src/server/ratings.ts`)
 * and the arena liveness check every five (`src/server/liveness.ts`).
 */
import handler from "@tanstack/react-start/server-entry";
import { handleEdge } from "./server/edge";
import { getRateLimiter } from "./server/env";
import { runLivenessCheck } from "./server/liveness";
import { RATINGS_CRON, runRatingJob } from "./server/ratings";

export default {
  fetch(request, env) {
    return handleEdge(request, env, getRateLimiter(), async (r) => handler.fetch(r));
  },

  scheduled(controller, env, ctx) {
    const now = new Date(controller.scheduledTime);
    if (controller.cron === RATINGS_CRON) ctx.waitUntil(runRatingJob(env, now));
    else ctx.waitUntil(runLivenessCheck(env, now));
  },
} satisfies ExportedHandler<Env>;
