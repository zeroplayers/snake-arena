/**
 * The Worker's entry (wrangler.jsonc `main`). Requests go through the edge checks
 * (`src/server/edge.ts`: rate limits, request log, metrics) into TanStack Start, except the live
 * showcase's WebSocket, which goes to the arena (`src/server/showcase.ts`). Cron Triggers
 * (`triggers.crons` in wrangler.jsonc) run the rating job every minute (`src/server/ratings.ts`)
 * and the arena liveness check every five (`src/server/liveness.ts`).
 */
import handler from "@tanstack/react-start/server-entry";
import { handleEdge } from "./server/edge";
import { getRateLimiter } from "./server/env";
import { runLivenessCheck } from "./server/liveness";
import { RATINGS_CRON, runRatingJob } from "./server/ratings";
import { handleShowcase } from "./server/showcase";
import { SHOWCASE_PATH } from "./site";

export default {
  fetch(request, env) {
    if (new URL(request.url).pathname === SHOWCASE_PATH) {
      return handleShowcase(request, env.ARENA, getRateLimiter());
    }
    return handleEdge(request, env, getRateLimiter(), async (r) => handler.fetch(r));
  },

  scheduled(controller, env, ctx) {
    const now = new Date(controller.scheduledTime);
    if (controller.cron === RATINGS_CRON) ctx.waitUntil(runRatingJob(env, now));
    else ctx.waitUntil(runLivenessCheck(env, now));
  },
} satisfies ExportedHandler<Env>;
