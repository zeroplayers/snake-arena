/**
 * Rate limits for the site's API, on Cloudflare's Workers Rate Limiting bindings (`ratelimits`
 * in wrangler.jsonc, one binding per rule).
 *
 * Why the bindings and not a Durable Object or D1 counter: a check costs no request to anything
 * else (the counter lives in the Cloudflare location that served the request), so it can run on
 * every API call. The price is precision: counts are per location and eventually consistent, so
 * a client spread over many locations, or a burst landing before the counters sync, gets
 * somewhat more than `limit`. That's fine for what these limits are for, shedding load and
 * slowing down guessing. Everything that must be exact is counted in D1 in the same statement
 * as the write: deploys per day, bots per author (`src/shared/deploy.ts`), lives per day (the
 * matchmaker). If a rule ever needs to be exact, a Durable Object per key can implement
 * `RateLimitBinding` without touching the callers.
 *
 * Rules (the limits themselves are in wrangler.jsonc; `RATE_LIMITS` must match it, a test
 * checks):
 * - `ip`: every `/api/*` and server-function request, per client IP (IPv6 per /64).
 * - `auth`: sign-in, the OAuth callback, device codes and their approval, username claims,
 *   per client IP. Session reads and the CLI's token polling aren't in it: polling follows the
 *   device flow's own interval (5 s, `slow_down` adds 5 s), and a refused poll gets
 *   `slow_down`, so the CLI backs off the way RFC 8628 says.
 * - `user`: every CLI API call and site server function of a signed-in user (CLI token or web
 *   session alike), per user id.
 * - `deploy`: deploys per user, on top of `user` and the daily quota.
 *
 * A missing binding or a failing check lets the request through (logged): the limiter must not
 * take the site down with it.
 */
import { type MetricsDataset, writeMetric } from "@zerosnake/observability";
import type { ApiErrorBody } from "../shared/deploy";
import { currentRequest } from "./request-context";

export const RATE_LIMITS = {
  ip: { binding: "RATE_LIMIT_IP", limit: 300, period: 60 },
  auth: { binding: "RATE_LIMIT_AUTH", limit: 30, period: 60 },
  user: { binding: "RATE_LIMIT_USER", limit: 120, period: 60 },
  deploy: { binding: "RATE_LIMIT_DEPLOY", limit: 6, period: 60 },
} as const;

export type RateLimitRule = keyof typeof RATE_LIMITS;

/** The Workers Rate Limiting binding's API. */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export type RateLimitEnv = {
  [R in RateLimitRule as (typeof RATE_LIMITS)[R]["binding"]]?: RateLimitBinding;
} & { METRICS?: MetricsDataset };

export type RateLimitVerdict =
  | { ok: true }
  | { ok: false; rule: RateLimitRule; limit: number; period: number; retryAfter: number };

export interface RateLimiter {
  check(rule: RateLimitRule, key: string): Promise<RateLimitVerdict>;
}

/** Allows everything; for tests and callers without bindings. */
export const noRateLimit: RateLimiter = { check: async () => ({ ok: true }) };

export function createRateLimiter(env: RateLimitEnv): RateLimiter {
  const warned = new Set<RateLimitRule>();
  return {
    async check(rule, key) {
      const { binding, limit, period } = RATE_LIMITS[rule];
      const limiter = env[binding];
      if (!limiter) {
        if (!warned.has(rule)) {
          warned.add(rule);
          console.warn(`rate limit binding ${binding} is missing; "${rule}" isn't enforced`);
        }
        return { ok: true };
      }
      let success: boolean;
      try {
        ({ success } = await limiter.limit({ key: `${rule}:${key}` }));
      } catch (error) {
        console.error("rate limit check failed; letting the request through", rule, error);
        return { ok: true };
      }
      if (success) return { ok: true };
      writeMetric(env.METRICS, "ratelimit.limited", {
        rule,
        route: currentRequest()?.route ?? null,
      });
      // The binding doesn't say when its window ends; a whole period is always enough.
      return { ok: false, rule, limit, period, retryAfter: period };
    },
  };
}

export function rateLimitedBody(verdict: Extract<RateLimitVerdict, { ok: false }>): ApiErrorBody {
  return {
    error: "rate_limited",
    message: `Too many requests (more than ${verdict.limit} a ${verdict.period === 60 ? "minute" : `${verdict.period} s`}). Try again in ${verdict.retryAfter} s.`,
    limit: verdict.limit,
    retryAfter: verdict.retryAfter,
  };
}

export function rateLimitedResponse(verdict: Extract<RateLimitVerdict, { ok: false }>) {
  return Response.json(rateLimitedBody(verdict), {
    status: 429,
    headers: { "retry-after": String(verdict.retryAfter), "cache-control": "no-store" },
  });
}

/**
 * The key for per-IP rules: `CF-Connecting-IP`, IPv6 cut to its /64 (one subscriber usually
 * gets a whole /64, so per-address limits would be trivial to dodge). `unknown` without the
 * header (local dev).
 */
export function clientIpKey(headers: Headers) {
  const ip = headers.get("cf-connecting-ip")?.trim();
  if (!ip) return "unknown";
  if (!ip.includes(":")) return ip;
  const groups = expandIpv6(ip);
  return groups ? `${groups.slice(0, 4).join(":")}::/64` : ip;
}

/** The eight 16-bit groups of an IPv6 address, lowercase, without leading zeros; `null` if invalid. */
function expandIpv6(ip: string): string[] | null {
  const [head = "", tail, extra] = ip.toLowerCase().split("::");
  if (extra !== undefined) return null;
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  // An embedded IPv4 tail (`::ffff:1.2.3.4`) takes two groups.
  const last = right.length ? right : left;
  if (last.at(-1)?.includes(".")) {
    const parts = last.pop()?.split(".").map(Number) ?? [];
    if (parts.length !== 4 || parts.some((p) => !(p >= 0 && p <= 255))) return null;
    const [a = 0, b = 0, c = 0, d = 0] = parts;
    last.push(((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
  }
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill("0"), ...right];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => Number.parseInt(g, 16).toString(16));
}
