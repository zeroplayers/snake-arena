import { MATCHMAKER_NAME } from "@zerosnake/web/shared";
import { type CheckJob, handleChecks, reapStaleVersions } from "./checks";
import { sweepTraces } from "./traces";

export { MatchmakerDO } from "./matchmaker";
export { RoomDO } from "./room";
// The live showcase's spectators: only the site's `SHOWCASE` service binding reaches the entrypoint.
export { ShowcaseDO, ShowcaseEntrypoint } from "./showcase";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      const matchmaker = env.MATCHMAKER.get(env.MATCHMAKER.idFromName(MATCHMAKER_NAME));
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
    const matchmaker = env.MATCHMAKER.get(env.MATCHMAKER.idFromName(MATCHMAKER_NAME));
    // `ping` (re)starts the matchmaker's alarm loop, e.g. on the first deploy.
    const [reaped, pinged, swept] = await Promise.allSettled([
      reapStaleVersions(env),
      matchmaker.ping(),
      sweepTraces(env.TRACES, Date.now()),
    ]);
    if (swept.status === "rejected") console.error("trace sweep failed", swept.reason);
    if (reaped.status === "rejected") throw reaped.reason;
    if (pinged.status === "rejected") throw pinged.reason;
  },
} satisfies ExportedHandler<Env, CheckJob>;
