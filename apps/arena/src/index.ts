import { type CheckJob, handleChecks } from "./checks";

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
} satisfies ExportedHandler<Env, CheckJob>;
