/**
 * The CLI API through the app's real route tree, dispatched the way TanStack Start's
 * `handleServerRoutes` does it: match the path, pick the leaf route's handler for the method.
 * `cloudflare:workers` is aliased to `src/test/cloudflare-workers.ts`, filled with test bindings.
 */
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getRouter } from "../router";
import type { ApiErrorBody, BotInfo, DeployResponse, MeResponse, VersionInfo } from "../shared";
import { createTestPlatform } from "../test/d1";
import { hashToken } from "./cli-auth";

const BASE = "http://localhost:3000";

type Handler = (ctx: {
  request: Request;
  params: Record<string, string>;
  pathname: string;
  context: object;
}) => Response | Promise<Response>;

/** `null` when no route has a handler for this method and path (Start would render the app). */
function dispatch(request: Request): Promise<Response> | null {
  const { pathname } = new URL(request.url);
  const [, params, route] = getRouter().getMatchedRoutes(pathname) as unknown as [
    unknown,
    Record<string, string>,
    { options: { server?: { handlers?: Record<string, Handler> } } } | undefined,
  ];
  const handler = route?.options.server?.handlers?.[request.method];
  if (!handler || params["**"] !== undefined) return null;
  return Promise.resolve(handler({ request, params, pathname, context: {} }));
}

let platform: Awaited<ReturnType<typeof createTestPlatform>>;
let token: string;

beforeAll(async () => {
  platform = await createTestPlatform();
  Object.assign(env, platform.env);
  token = `zsk_${crypto.randomUUID()}`;
  await platform.env.DB.batch([
    platform.env.DB.prepare(
      "INSERT INTO users (id, name, email, username) VALUES ('u1', 'Ada', 'ada@example.com', 'ada')",
    ),
    platform.env.DB.prepare(
      "INSERT INTO cli_tokens (id, user_id, token_hash, expires_at) VALUES ('t1', 'u1', ?, ?)",
    ).bind(await hashToken(token), Date.now() + 86_400_000),
  ]);
});

afterAll(async () => {
  await platform?.dispose();
});

function call(method: string, path: string, init: { body?: unknown; headers?: HeadersInit } = {}) {
  const headers = new Headers(init.headers ?? { authorization: `Bearer ${token}` });
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const request = new Request(`${BASE}${path}`, {
    method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const response = dispatch(request);
  if (!response) throw new Error(`no handler for ${method} ${path}`);
  return response;
}

describe("CLI API routes", () => {
  it("create a bot, deploy it, read the version and /api/me", async () => {
    const created = await call("POST", "/api/bots", { body: { name: "Route Snake" } });
    expect(created.status).toBe(201);
    const bot = (await created.json()) as BotInfo;
    expect(bot.slug).toBe("route-snake");

    const deployed = await call("POST", "/api/bots/route-snake/versions", {
      body: {
        bundle: "export default { tick() { return { turn: 0 }; } };",
        sources: [{ path: "src/bot.ts", content: "// bot" }],
      },
    });
    expect(deployed.status).toBe(201);
    expect(deployed.headers.get("location")).toBe("/api/bots/route-snake/versions/1");
    const { version } = (await deployed.json()) as DeployResponse;
    expect(version).toMatchObject({ n: 1, status: "validating", bot: { id: bot.id } });
    expect(await platform.env.BUNDLES.list()).toMatchObject({ objects: [expect.anything()] });

    const read = await call("GET", `/api/bots/${bot.id}/versions/1`);
    expect(read.status).toBe(200);
    expect((await read.json()) as VersionInfo).toEqual(version);

    const lives = await call("GET", "/api/bots/route-snake/versions/1/lives?limit=5");
    expect(lives.status).toBe(200);
    expect(await lives.json()).toEqual({ lives: [] });
    const trace = await call("GET", "/api/lives/no-such-life/trace");
    expect(trace.status).toBe(404);
    expect(await trace.json()).toMatchObject({ error: "life_not_found" });

    const me = (await (await call("GET", "/api/me")).json()) as MeResponse;
    expect(me.user.username).toBe("ada");
    expect(me.bots).toEqual([
      expect.objectContaining({
        slug: "route-snake",
        latestVersion: expect.objectContaining({ n: 1 }),
      }),
    ]);
  });

  it("answer with JSON errors, and only to CLI tokens", async () => {
    const cookie = { cookie: "better-auth.session_token=abc.def", origin: BASE };
    for (const [method, path] of [
      ["GET", "/api/me"],
      ["POST", "/api/bots"],
      ["POST", "/api/bots/route-snake/versions"],
      ["GET", "/api/bots/route-snake/versions/1"],
      ["GET", "/api/bots/route-snake/versions/1/lives"],
      ["GET", "/api/lives/some-life/trace"],
    ] as const) {
      for (const headers of [{}, cookie, { authorization: "Bearer zsk_nope" }]) {
        const res = await call(method, path, { headers, body: method === "POST" ? {} : undefined });
        expect(res.status).toBe(401);
        expect(((await res.json()) as ApiErrorBody).error).toBe("unauthorized");
      }
    }
    const missing = await call("GET", "/api/bots/route-snake/versions/9");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "version_not_found" });
  });

  it("have no handlers for other methods", () => {
    for (const [method, path] of [
      ["GET", "/api/bots"],
      ["GET", "/api/bots/x/versions"],
      ["POST", "/api/me"],
      ["POST", "/api/bots/x/versions/1"],
      ["POST", "/api/lives/x/trace"],
    ] as const) {
      expect(dispatch(new Request(`${BASE}${path}`, { method }))).toBeNull();
    }
  });
});
