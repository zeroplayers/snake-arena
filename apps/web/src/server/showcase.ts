/**
 * `/api/showcase`: the live showcase's WebSocket (#27), proxied to the arena Worker's `/showcase`
 * over the `ARENA` service binding.
 *
 * Why proxy rather than link browsers to api.arena.surninsynergy.dev: the page stays on its own
 * origin (no second hostname to configure per environment, nothing for CSP to allow), and the
 * connection gets the site's per-IP rate limit. Messages don't run this Worker's code: the
 * runtime passes the upgraded socket through. The arena hands it to the showcase room
 * (`apps/arena/src/showcase.ts`).
 *
 * Not behind `handleEdge`: its request log and request-id header would rewrap the 101 response.
 */
import { clientIpKey, type RateLimiter, rateLimitedResponse } from "./rate-limit";

export async function handleShowcase(
  request: Request,
  arena: Fetcher,
  limiter: RateLimiter,
): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }
  const verdict = await limiter.check("ip", clientIpKey(request.headers));
  if (!verdict.ok) return rateLimitedResponse(verdict);
  const url = new URL(request.url);
  return arena.fetch(new Request(`https://arena/showcase${url.search}`, request));
}
