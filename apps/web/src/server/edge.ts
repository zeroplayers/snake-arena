/**
 * What every API request goes through before TanStack Start sees it (`src/server.ts`):
 *
 * 1. a request id (`cf-ray`, or a UUID locally), sent back as `x-request-id`;
 * 2. the per-IP rate limits (`src/server/rate-limit.ts`): `ip` for everything below, plus
 *    `auth` for the auth endpoints that create things (sign-in, device codes, approvals,
 *    usernames). The per-user limits are applied by the handlers, which know the user;
 * 3. one structured log line per request (`api.request`: request id, user id, route, status,
 *    latency, outcome) and the counters in Analytics Engine: deploys accepted/rejected,
 *    authentication failures, 5xx and exceptions (429s are counted by the limiter itself).
 *
 * Covered: `/api/*` and server functions (`/_serverFn/*`). Pages and assets pass straight
 * through (Workers Logs has their invocation logs); only their 5xx are counted (`http.error`).
 */
import { log, type MetricsDataset, writeMetric } from "@zerosnake/observability";
import {
  clientIpKey,
  type RateLimiter,
  type RateLimitVerdict,
  rateLimitedResponse,
} from "./rate-limit";
import { type RequestContext, runWithRequest } from "./request-context";

export interface EdgeEnv {
  METRICS?: MetricsDataset;
}

export type RouteKind =
  /** CLI API and other `/api/*` routes. */
  | "api"
  /** Better Auth endpoints that only read (the session, the CLI token list). */
  | "auth"
  /** Better Auth endpoints that create or change something: also the `auth` rate limit. */
  | "auth_write"
  /** The CLI's device-flow token polling: refused polls get RFC 8628 `slow_down`. */
  | "device_poll"
  /** TanStack Start server functions (bot management, admin, page loaders). */
  | "server_fn"
  /** Everything else: not limited or logged here. */
  | "page";

const AUTH_READS = new Set(["/api/auth/get-session", "/api/auth/cli/me", "/api/auth/cli/tokens"]);

/** The route pattern of a path (ids replaced, so logs and metrics group by endpoint). */
export function classify(method: string, pathname: string): { route: string; kind: RouteKind } {
  if (pathname.startsWith("/_serverFn/")) return { route: "/_serverFn", kind: "server_fn" };
  if (!pathname.startsWith("/api/")) return { route: pathname, kind: "page" };
  if (pathname.startsWith("/api/auth/")) {
    if (pathname === "/api/auth/cli/token") return { route: pathname, kind: "device_poll" };
    const callback = /^\/api\/auth\/callback\/[^/]+$/.test(pathname);
    // A pathname may carry anything; keep the route label to known shapes.
    const route = callback
      ? "/api/auth/callback/:provider"
      : /^\/api\/auth(\/[a-z-]+){1,3}$/.test(pathname)
        ? pathname
        : "/api/auth/*";
    const read = method === "GET" && AUTH_READS.has(pathname);
    return { route, kind: read ? "auth" : "auth_write" };
  }
  const patterns: [RegExp, string][] = [
    [/^\/api\/bots\/[^/]+\/versions\/[^/]+$/, "/api/bots/:bot/versions/:n"],
    [/^\/api\/bots\/[^/]+\/versions$/, "/api/bots/:bot/versions"],
    [/^\/api\/users\/[^/]+$/, "/api/users/:username"],
    [/^\/api\/lives\/[^/]+\/replay$/, "/api/lives/:id/replay"],
    [/^\/api\/account\/files\/[^/]+\/[^/]+$/, "/api/account/files/:version/:kind"],
    [/^\/api\/account\/(export|delete)$/, pathname],
    [/^\/api\/(me|bots|health)$/, pathname],
  ];
  const route = patterns.find(([re]) => re.test(pathname))?.[1] ?? "/api/*";
  return { route, kind: "api" };
}

function slowDown(verdict: Extract<RateLimitVerdict, { ok: false }>) {
  // RFC 8628 §3.5: the client adds 5 s to its polling interval. Same answer as the device
  // plugin's own per-code throttle, so the CLI handles both the same way.
  return Response.json(
    {
      error: "slow_down",
      error_description: "Polling too fast from this network; slow down.",
    },
    {
      status: 400,
      headers: { "retry-after": String(verdict.retryAfter), "cache-control": "no-store" },
    },
  );
}

async function refusal(limiter: RateLimiter, kind: RouteKind, ip: string) {
  const byIp = await limiter.check("ip", ip);
  if (!byIp.ok) return byIp;
  if (kind === "auth_write") {
    const byAuth = await limiter.check("auth", ip);
    if (!byAuth.ok) return byAuth;
  }
  return null;
}

/** Which authentication failure a response is, if any (`auth.failure` metric). */
function authFailure(
  kind: RouteKind,
  route: string,
  response: Response,
  outcome: string | undefined,
) {
  const { status } = response;
  // `/api/account/*` takes the web session, the rest of `/api/*` a CLI token.
  if (kind === "api" && status === 401) {
    return route.startsWith("/api/account/") ? "session" : "cli_token";
  }
  if (kind === "server_fn" && outcome === "unauthorized") return "session";
  if (kind === "auth" || kind === "auth_write") {
    if (status === 401 || status === 403) return "auth_api";
    const location = response.headers.get("location") ?? "";
    if (status >= 300 && status < 400 && /[?&]error=/.test(location)) return "oauth";
  }
  return null;
}

function withRequestId(response: Response, requestId: string) {
  try {
    response.headers.set("x-request-id", requestId);
    return response;
  } catch {
    // Immutable headers (a response passed through from `fetch`): copy it.
    const copy = new Response(response.body, response);
    copy.headers.set("x-request-id", requestId);
    return copy;
  }
}

export async function handleEdge(
  request: Request,
  env: EdgeEnv,
  limiter: RateLimiter,
  next: (request: Request) => Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url);
  const { route, kind } = classify(request.method, url.pathname);
  if (kind === "page") {
    const response = await next(request);
    if (response.status >= 500) {
      writeMetric(env.METRICS, "http.error", {
        route: "page",
        outcome: `http_${response.status}`,
        status: response.status,
      });
    }
    return response;
  }

  const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
  const context: RequestContext = { requestId, route };
  const started = Date.now();
  const fields = () => ({
    requestId,
    method: request.method,
    route,
    userId: context.userId,
    latencyMs: Date.now() - started,
  });

  let response: Response;
  try {
    response = await runWithRequest(context, async () => {
      const refused = await refusal(limiter, kind, clientIpKey(request.headers));
      if (refused) {
        context.outcome = kind === "device_poll" ? "slow_down" : "rate_limited";
        return kind === "device_poll" ? slowDown(refused) : rateLimitedResponse(refused);
      }
      return next(request);
    });
  } catch (error) {
    log("error", "api.request", { ...fields(), status: 500, outcome: "exception", error });
    writeMetric(env.METRICS, "http.error", { route, outcome: "exception", status: 500 });
    throw error;
  }

  const { status } = response;
  const outcome = context.outcome ?? (status < 400 ? "ok" : `http_${status}`);
  log(status >= 500 ? "error" : status >= 400 ? "warn" : "info", "api.request", {
    ...fields(),
    status,
    outcome,
  });

  if (route === "/api/bots/:bot/versions" && request.method === "POST") {
    const userId = context.userId ?? null;
    if (status === 200 || status === 201) {
      writeMetric(env.METRICS, "deploy.accepted", { userId, status });
    } else {
      writeMetric(env.METRICS, "deploy.rejected", { reason: outcome, userId, status });
    }
  }
  if (status >= 500) writeMetric(env.METRICS, "http.error", { route, outcome, status });
  const failure = authFailure(kind, route, response, context.outcome);
  if (failure) writeMetric(env.METRICS, "auth.failure", { kind: failure, route, status });

  return withRequestId(response, requestId);
}
