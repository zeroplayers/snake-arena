/**
 * `/api/showcase`: the live showcase's WebSocket (#27), proxied to the arena Worker over the
 * `SHOWCASE` service binding: its `ShowcaseEntrypoint`, which has no public URL, so this is the
 * only way in (apps/arena `src/showcase.ts`).
 *
 * Why proxy rather than link browsers to the arena: the page stays on its own origin (no second
 * hostname to configure per environment, nothing for CSP to allow), and the connection gets the
 * site's per-IP rate limit on opening sockets. How many sockets one client holds is capped by the
 * room, from the client key sent in `SHOWCASE_CLIENT_HEADER` (the IP, an IPv6 /64; the arena
 * hashes it). Messages don't run this Worker's code: the runtime passes the upgraded socket
 * through.
 *
 * Not behind `handleEdge`: its request log and request-id header would rewrap the 101 response.
 */
import { clientIpKey, type RateLimiter, rateLimitedResponse } from "./rate-limit";

/** Same name as `SHOWCASE_CLIENT_HEADER` in apps/arena `src/showcase/rule.ts`. */
export const SHOWCASE_CLIENT_HEADER = "x-showcase-client";

export async function handleShowcase(
  request: Request,
  arena: Fetcher,
  limiter: RateLimiter,
): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }
  const client = clientIpKey(request.headers);
  const verdict = await limiter.check("ip", client);
  if (!verdict.ok) return rateLimitedResponse(verdict);
  // Only the upgrade goes on: no query, and whatever the browser sent as the client is replaced.
  const headers = new Headers(request.headers);
  headers.set(SHOWCASE_CLIENT_HEADER, client);
  return arena.fetch(new Request("https://arena/showcase", { headers }));
}
