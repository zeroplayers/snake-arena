import { type CheckJob, handleChecks, reapStaleVersions } from "./checks";
import { sweepTraces } from "./traces";

export { MatchmakerDO } from "./matchmaker";
export { RoomDO } from "./room";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      const matchmaker = env.MATCHMAKER.get(env.MATCHMAKER.idFromName("global"));
      return Response.json({
        ok: true,
        environment: env.ENVIRONMENT,
        matchmaker: await matchmaker.ping(),
      });
    }
    return new Response("Not found", { status: 404 });
  },

  queue: handleChecks,

  async scheduled(_controller, env) {
    const [reaped, swept] = await Promise.allSettled([
      reapStaleVersions(env),
      sweepTraces(env.TRACES, Date.now()),
    ]);
    if (swept.status === "rejected") console.error("trace sweep failed", swept.reason);
    if (reaped.status === "rejected") throw reaped.reason;
  },
} satisfies ExportedHandler<Env, CheckJob>;
