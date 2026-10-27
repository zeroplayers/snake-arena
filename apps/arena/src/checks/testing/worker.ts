/**
 * Test entry for `checks.test.ts`: the checks consumer and reaper as `index.ts` wires them, plus
 * `POST /send` to put a job on `CHECKS_QUEUE` the way the deploy API does, and `GET /metrics`
 * for the points written to the test `METRICS` binding (`testing/metrics.ts`; kept in memory, as
 * the queue and cron handlers run in this isolate).
 */
import { handleChecks, reapStaleVersions } from "../../checks.ts";
import { type DataPoint, withTestMetrics } from "../../testing/metrics.ts";

const points: DataPoint[] = [];
const metered = (env: Env) => withTestMetrics(env, (p) => points.push(p));

export default {
  async fetch(request, env) {
    if (request.method === "GET") return Response.json(points);
    await env.CHECKS_QUEUE.send(await request.json(), { contentType: "json" });
    return new Response(null, { status: 204 });
  },
  async queue(batch, env) {
    await handleChecks(batch, metered(env));
  },
  async scheduled(controller, env) {
    await reapStaleVersions(metered(env), controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
