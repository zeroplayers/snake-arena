import { MATCHMAKER_NAME } from "@zerosnake/web/shared";
import { type CheckJob, handleChecks, reapStaleVersions } from "./checks";

export { MatchmakerDO } from "./matchmaker";
export { RoomDO } from "./room";

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
    await Promise.all([reapStaleVersions(env), matchmaker.ping()]);
  },
} satisfies ExportedHandler<Env, CheckJob>;
