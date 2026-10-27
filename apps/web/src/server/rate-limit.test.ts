/**
 * Rate limits: the rules against wrangler.jsonc, the limiter on Miniflare's rate limit
 * bindings (exact within one process, so concurrent requests can be counted), the edge's
 * per-IP checks and the CLI API's per-user ones.
 */
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { experimental_readRawConfig as readRawConfig } from "wrangler";
import type { ApiErrorBody } from "../shared";
import { createTestPlatform, type TestPlatformOptions } from "../test/d1";
import { createCliApi } from "./cli-api";
import { hashToken } from "./cli-auth";
import { classify, handleEdge } from "./edge";
import {
  clientIpKey,
  createRateLimiter,
  RATE_LIMITS,
  type RateLimitBinding,
  type RateLimitRule,
} from "./rate-limit";

const BASE = "http://localhost:3000";

let platform: Awaited<ReturnType<typeof createTestPlatform>> | undefined;
let points: { blobs?: (string | null)[]; doubles?: number[] }[];
const metrics = { writeDataPoint: (p?: (typeof points)[number]) => p && points.push(p) };

async function setup(options: TestPlatformOptions = {}) {
  platform = await createTestPlatform(options);
  points = [];
  return platform.env;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await platform?.dispose();
  platform = undefined;
});

const metricNames = () => points.map((p) => p.blobs?.[0]);

describe("RATE_LIMITS", () => {
  it("match the bindings in wrangler.jsonc, top level and staging, with unique namespaces", () => {
    const { rawConfig } = readRawConfig({
      config: join(import.meta.dirname, "../../wrangler.jsonc"),
    });
    const environments = { development: rawConfig, staging: rawConfig.env?.staging };
    const namespaces: string[] = [];
    for (const [name, config] of Object.entries(environments)) {
      const bindings: { name: string; namespace_id: string; simple: object }[] =
        config?.ratelimits ?? [];
      expect(bindings.map((b) => b.name).sort(), name).toEqual(
        Object.values(RATE_LIMITS)
          .map((r) => r.binding)
          .sort(),
      );
      for (const { binding, limit, period } of Object.values(RATE_LIMITS)) {
        const configured = bindings.find((b) => b.name === binding);
        expect(configured?.simple, `${name} ${binding}`).toEqual({ limit, period });
        namespaces.push(configured?.namespace_id ?? "");
      }
    }
    expect(new Set(namespaces).size).toBe(namespaces.length);
  });
});

describe("clientIpKey", () => {
  const key = (ip?: string) =>
    clientIpKey(new Headers(ip === undefined ? {} : { "cf-connecting-ip": ip }));

  it("uses IPv4 addresses as they are", () => {
    expect(key("203.0.113.7")).toBe("203.0.113.7");
    expect(key()).toBe("unknown");
  });

  it("groups IPv6 addresses by /64, however they're written", () => {
    const a = key("2001:db8:1234:5678::1");
    expect(a).toBe("2001:db8:1234:5678::/64");
    expect(key("2001:0DB8:1234:5678:ffff:0:0:2")).toBe(a);
    expect(key("2001:db8:1234:5678:1:2:3:4")).toBe(a);
    expect(key("2001:db8:1234:5679::1")).not.toBe(a);
    expect(key("::1")).toBe("0:0:0:0::/64");
    expect(key("::ffff:192.0.2.1")).toBe("0:0:0:0::/64");
    // Garbage is still a key, just its own.
    expect(key("not:an::ip::")).toBe("not:an::ip::");
  });
});

describe("createRateLimiter", () => {
  it("lets exactly `limit` of many concurrent checks through, per key", async () => {
    const env = await setup({ rateLimits: { user: 7 } });
    const limiter = createRateLimiter({ ...env, METRICS: metrics });
    const verdicts = await Promise.all(
      Array.from({ length: 30 }, () => limiter.check("user", "alice")),
    );
    expect(verdicts.filter((v) => v.ok)).toHaveLength(7);
    expect(verdicts.find((v) => !v.ok)).toEqual({
      ok: false,
      rule: "user",
      limit: RATE_LIMITS.user.limit,
      period: 60,
      retryAfter: 60,
    });
    // Another key, and the same key under another rule, have their own counts.
    expect(await limiter.check("user", "bob")).toEqual({ ok: true });
    expect(await limiter.check("deploy", "alice")).toEqual({ ok: true });
    expect(metricNames().filter((n) => n === "ratelimit.limited")).toHaveLength(23);
  });

  it("lets requests through when a binding is missing or fails", async () => {
    const failing: RateLimitBinding = {
      limit: () => Promise.reject(new Error("rate limiter down")),
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const limiter = createRateLimiter({ RATE_LIMIT_AUTH: failing });
    expect(await limiter.check("ip", "x")).toEqual({ ok: true });
    expect(await limiter.check("auth", "x")).toEqual({ ok: true });
    expect(error).toHaveBeenCalled();
  });
});

describe("classify", () => {
  it.each([
    ["GET", "/api/me", "/api/me", "api"],
    ["POST", "/api/bots/snake/versions", "/api/bots/:bot/versions", "api"],
    ["GET", "/api/bots/snake/versions/12", "/api/bots/:bot/versions/:n", "api"],
    ["GET", "/api/users/ada", "/api/users/:username", "api"],
    ["GET", "/api/nope/x/y", "/api/*", "api"],
    ["GET", "/api/auth/get-session", "/api/auth/get-session", "auth"],
    ["POST", "/api/auth/sign-in/social", "/api/auth/sign-in/social", "auth_write"],
    ["GET", "/api/auth/callback/github", "/api/auth/callback/:provider", "auth_write"],
    ["GET", "/api/auth/device", "/api/auth/device", "auth_write"],
    ["POST", "/api/auth/device/approve", "/api/auth/device/approve", "auth_write"],
    ["POST", "/api/auth/cli/token", "/api/auth/cli/token", "device_poll"],
    ["GET", "/api/auth/%00weird/../x", "/api/auth/*", "auth_write"],
    ["POST", "/_serverFn/abc123", "/_serverFn", "server_fn"],
    ["GET", "/leaderboard", "/leaderboard", "page"],
  ])("%s %s → %s (%s)", (method, path, route, kind) => {
    expect(classify(method, path)).toEqual({ route, kind });
  });
});

// ─── Through the edge ────────────────────────────────────────────────────────────────────────────

function request(path: string, init: RequestInit & { ip?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("cf-connecting-ip", init.ip ?? "198.51.100.1");
  return new Request(`${BASE}${path}`, { ...init, headers });
}

describe("handleEdge", () => {
  it("refuses concurrent requests from one IP over the limit with a 429 ApiErrorBody", async () => {
    const env = await setup({ rateLimits: { ip: 5 } });
    const limiter = createRateLimiter({ ...env, METRICS: metrics });
    const next = vi.fn(async () => Response.json({ ok: true }));
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        handleEdge(request("/api/health"), { METRICS: metrics }, limiter, next),
      ),
    );
    expect(responses.filter((r) => r.status === 200)).toHaveLength(5);
    expect(next).toHaveBeenCalledTimes(5);
    const refused = responses.find((r) => r.status === 429);
    expect(refused?.headers.get("retry-after")).toBe("60");
    expect(refused?.headers.get("x-request-id")).toEqual(expect.any(String));
    expect(await refused?.json()).toEqual({
      error: "rate_limited",
      message: expect.stringMatching(/try again in 60 s/i),
      limit: RATE_LIMITS.ip.limit,
      retryAfter: 60,
    } satisfies ApiErrorBody);
    // Another IP isn't affected.
    const other = await handleEdge(
      request("/api/health", { ip: "198.51.100.2" }),
      {},
      limiter,
      next,
    );
    expect(other.status).toBe(200);
    expect(metricNames().filter((n) => n === "ratelimit.limited")).toHaveLength(15);
  });

  it("adds the stricter auth limit to auth writes, not to session reads", async () => {
    const env = await setup({ rateLimits: { auth: 2 } });
    const limiter = createRateLimiter(env);
    const next = async () => new Response("{}", { status: 200 });
    const codes = async (path: string, method: string, n: number) => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        out.push((await handleEdge(request(path, { method }), {}, limiter, next)).status);
      }
      return out;
    };
    expect(await codes("/api/auth/device/code", "POST", 3)).toEqual([200, 200, 429]);
    expect(await codes("/api/auth/get-session", "GET", 3)).toEqual([200, 200, 200]);
    expect(await codes("/api/auth/cli/token", "POST", 3)).toEqual([200, 200, 200]);
  });

  it("answers refused device-flow polls with RFC 8628 slow_down", async () => {
    const env = await setup({ rateLimits: { ip: 1 } });
    const limiter = createRateLimiter(env);
    const next = async () => Response.json({ error: "authorization_pending" }, { status: 400 });
    const poll = () =>
      handleEdge(request("/api/auth/cli/token", { method: "POST" }), {}, limiter, next);
    expect(await (await poll()).json()).toEqual({ error: "authorization_pending" });
    const refused = await poll();
    expect(refused.status).toBe(400);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(await refused.json()).toMatchObject({ error: "slow_down" });
  });

  it("logs one structured line per request and passes pages through untouched", async () => {
    const env = await setup();
    const limiter = createRateLimiter(env);
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const page = new Response("<html>");
    expect(await handleEdge(request("/leaderboard"), {}, limiter, async () => page)).toBe(page);
    expect(info).not.toHaveBeenCalled();

    const response = await handleEdge(
      request("/api/me", { headers: { "cf-ray": "8f00-AMS" } }),
      {},
      limiter,
      async () => Response.json({}),
    );
    expect(response.headers.get("x-request-id")).toBe("8f00-AMS");
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "info",
        event: "api.request",
        requestId: "8f00-AMS",
        method: "GET",
        route: "/api/me",
        status: 200,
        outcome: "ok",
        latencyMs: expect.any(Number),
      }),
    );
  });
});

describe("handleEdge metrics", () => {
  it("counts deploys, authentication failures and 5xx by route", async () => {
    const env = await setup();
    const limiter = createRateLimiter(env);
    const edge = (path: string, method: string, response: Response | Error) =>
      handleEdge(request(path, { method }), { METRICS: metrics }, limiter, async () => {
        if (response instanceof Error) throw response;
        return response;
      });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await edge("/api/bots/s/versions", "POST", new Response("{}", { status: 201 }));
    await edge("/api/bots/s/versions", "POST", new Response("{}", { status: 422 }));
    await edge("/api/me", "GET", new Response("{}", { status: 401 }));
    await edge(
      "/api/auth/callback/github",
      "GET",
      new Response(null, { status: 302, headers: { location: "/?error=state_mismatch" } }),
    );
    await edge("/api/me", "GET", new Response("{}", { status: 503 }));
    await edge("/bots", "GET", new Response("", { status: 500 }));
    await expect(edge("/api/me", "GET", new Error("boom"))).rejects.toThrow("boom");
    expect(points.map((p) => p.blobs)).toEqual([
      ["deploy.accepted", "web", null],
      ["deploy.rejected", "web", "http_422", null],
      ["auth.failure", "web", "cli_token", "/api/me"],
      ["auth.failure", "web", "oauth", "/api/auth/callback/:provider"],
      ["http.error", "web", "/api/me", "http_503"],
      ["http.error", "web", "page", "http_500"],
      ["http.error", "web", "/api/me", "exception"],
    ]);
  });
});

// ─── Per user, in the CLI API ────────────────────────────────────────────────────────────────────

describe("CLI API per-user limits", () => {
  async function cli(rateLimits: Partial<Record<RateLimitRule, number>>) {
    const env = await setup({ rateLimits });
    const tokens: Record<string, string> = {};
    for (const name of ["ada", "bob"]) {
      tokens[name] = `zsk_${crypto.randomUUID()}`;
      await env.DB.batch([
        env.DB.prepare("INSERT INTO users (id, name, email, username) VALUES (?, ?, ?, ?)").bind(
          name,
          name,
          `${name}@example.com`,
          name,
        ),
        env.DB.prepare(
          "INSERT INTO cli_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
        ).bind(`t-${name}`, name, await hashToken(tokens[name]), Date.now() + 86_400_000),
        env.DB.prepare(
          "INSERT INTO bots (id, owner_id, name, slug) VALUES (?, ?, 'Snake', 'snake')",
        ).bind(`bot-${name}`, name),
      ]);
    }
    const api = createCliApi(env, { rateLimiter: createRateLimiter(env) });
    const deploy = (who: string, i: number, idempotencyKey?: string) =>
      api.deploy(
        new Request(`${BASE}/api/bots/snake/versions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${tokens[who]}`,
            "content-type": "application/json",
            ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
          },
          body: JSON.stringify({
            bundle: `export default { tick() { return { turn: ${i} }; } };`,
            sources: [{ path: "src/bot.ts", content: `// ${i}` }],
          }),
        }),
        "snake",
      );
    const me = (who: string) =>
      api.me(
        new Request(`${BASE}/api/me`, { headers: { authorization: `Bearer ${tokens[who]}` } }),
      );
    return { deploy, me };
  }

  it("refuses concurrent deploys over the per-user deploy limit, each user on their own", async () => {
    const { deploy } = await cli({ deploy: 3 });
    const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => deploy("ada", i)));
    expect(responses.filter((r) => r.status === 201)).toHaveLength(3);
    const refused = responses.filter((r) => r.status === 429);
    expect(refused).toHaveLength(5);
    expect(refused[0]?.headers.get("retry-after")).toBe("60");
    expect(await refused[0]?.json()).toMatchObject({ error: "rate_limited", retryAfter: 60 });
    expect((await deploy("bob", 0)).status).toBe(201);
  });

  it("doesn't charge the deploy limit for retries with an Idempotency-Key in use", async () => {
    const { deploy } = await cli({ deploy: 1 });
    const first = await deploy("ada", 0, "retry-key-1");
    expect(first.status).toBe(201);
    const { version } = (await first.json()) as { version: { id: string } };
    for (let i = 0; i < 3; i++) {
      const replay = await deploy("ada", 0, "retry-key-1");
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ version: { id: version.id } });
    }
    // A new deploy (a new key, or none) is charged, and the one allowed is used up.
    expect((await deploy("ada", 1, "retry-key-2")).status).toBe(429);
    expect((await deploy("ada", 1)).status).toBe(429);
  });

  it("counts every call of a user against the user limit", async () => {
    const { me } = await cli({ user: 2 });
    expect((await me("ada")).status).toBe(200);
    expect((await me("ada")).status).toBe(200);
    expect((await me("ada")).status).toBe(429);
    expect((await me("bob")).status).toBe(200);
  });
});
