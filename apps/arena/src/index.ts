import { type CheckJob, handleChecks, reapStaleVersions } from "./checks";
import { handleShowcase } from "./showcase";

export { MatchmakerDO } from "./matchmaker";
export { RoomDO } from "./room";
export { ShowcaseDO } from "./showcase";

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
    if (url.pathname === "/showcase") return handleShowcase(request, env);
    return new Response("Not found", { status: 404 });
  },

  queue: handleChecks,

  async scheduled(_controller, env) {
    await reapStaleVersions(env);
  },
} satisfies ExportedHandler<Env, CheckJob>;
