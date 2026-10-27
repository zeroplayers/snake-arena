/**
 * Test entry for `checks.test.ts`: the checks consumer and reaper as `index.ts` wires them, plus
 * `POST /send` to put a job on `CHECKS_QUEUE` the way the deploy API does.
 */
import { handleChecks, reapStaleVersions } from "../../checks.ts";

export default {
  async fetch(request, env) {
    await env.CHECKS_QUEUE.send(await request.json(), { contentType: "json" });
    return new Response(null, { status: 204 });
  },
  queue: handleChecks,
  async scheduled(controller, env) {
    await reapStaleVersions(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
