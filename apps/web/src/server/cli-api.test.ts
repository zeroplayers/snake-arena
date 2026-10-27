import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ApiErrorBody,
  type BotInfo,
  type CheckJob,
  type CheckReport,
  type DeployLimits,
  type DeployRequest,
  type DeployResponse,
  isCheckJob,
  type MeResponse,
  type SourceArchive,
  type VersionInfo,
} from "../shared";
import { webSessions } from "../test/accounts";
import { createTestPlatform, type TestPlatformEnv } from "../test/d1";
import { CookieJar, mockGithub } from "../test/github";
import { createAuth } from "./auth";
import { createBotAdmin } from "./bot-admin";
import { type CliApiOptions, createCliApi, sourcePathProblem } from "./cli-api";
import { hashToken } from "./cli-auth";

const BASE = "http://localhost:3000";
const KiB = 1024;

let platform: Awaited<ReturnType<typeof createTestPlatform>>;
let env: TestPlatformEnv;
/** Every `CheckJob` sent, in order; sending goes on to the real (local) queue. */
let sent: CheckJob[];
let clock: Date;
/** Fault injection around the real bindings. */
let faults: {
  queue?: boolean;
  upload?: boolean;
  /** Only the `UPDATE … SET status` that marks a failed deploy. */
  abandon?: boolean;
  /** Every D1 query. */
  db?: boolean;
  /** Awaited (once) before the next queue send. */
  beforeSend?: () => Promise<void>;
};

beforeEach(async () => {
  platform = await createTestPlatform();
  env = platform.env;
  sent = [];
  faults = {};
  clock = new Date("2026-10-26T12:00:00Z");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await platform.dispose();
});

/** `target` with one method replaced; everything else bound to the real object. */
function override<T extends object>(target: T, name: keyof T, replacement: unknown): T {
  return new Proxy(target, {
    get(t, p) {
      if (p === name) return replacement;
      const value = Reflect.get(t, p);
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
}

/** Holds the next queue send until `release()` or `fail()`; `reached` resolves once it's waiting. */
function holdNextSend() {
  let reached!: () => void;
  let release!: () => void;
  let fail!: (error: Error) => void;
  const reachedPromise = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  faults.beforeSend = () => {
    reached();
    return gate;
  };
  return { reached: reachedPromise, release, fail: () => fail(new Error("queue down")) };
}

function api(options: { limits?: Partial<DeployLimits>; vars?: Record<string, string> } = {}) {
  const apiOptions: CliApiOptions = { now: () => clock };
  if (options.limits) apiOptions.limits = options.limits;
  return createCliApi(
    {
      ...env,
      ...options.vars,
      DB: override(env.DB, "prepare", (query: string) => {
        if (faults.db || (faults.abandon && /^update "versions" set "status"/.test(query))) {
          throw new Error("D1_ERROR: internal detail");
        }
        return env.DB.prepare(query);
      }),
      BUNDLES: override(env.BUNDLES, "put", (...args: Parameters<R2Bucket["put"]>) => {
        if (faults.upload) throw new Error("R2 down");
        return env.BUNDLES.put(...args);
      }),
      CHECKS_QUEUE: {
        send: async (body, sendOptions) => {
          const gate = faults.beforeSend;
          delete faults.beforeSend;
          await gate?.();
          if (faults.queue) throw new Error("queue down");
          await env.CHECKS_QUEUE.send(body, sendOptions);
          sent.push(body);
        },
      },
    },
    apiOptions,
  );
}

// ─── Fixtures ────────────────────────────────────────────────────────────────────────────────────

let users = 0;

/** A user with a username and a CLI token, as after `zerosnake login`; returns the token. */
async function cliUser(username = `user${++users}`) {
  const userId = crypto.randomUUID();
  const token = `zsk_${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, name, email, username) VALUES (?, ?, ?, ?)").bind(
      userId,
      username,
      `${username}@example.com`,
      username,
    ),
    env.DB.prepare(
      "INSERT INTO cli_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), userId, await hashToken(token), Date.now() + 86_400_000),
  ]);
  return { userId, token };
}

interface RequestOptions {
  method?: string;
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function request(path: string, { method = "GET", token, body, headers = {} }: RequestOptions = {}) {
  const h = new Headers(headers);
  if (token) h.set("authorization", `Bearer ${token}`);
  if (body !== undefined && !h.has("content-type")) h.set("content-type", "application/json");
  return new Request(`${BASE}${path}`, {
    method,
    headers: h,
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const deployBody = (overrides: Partial<DeployRequest> = {}): DeployRequest => ({
  bundle: "export default { tick() { return { turn: 0 }; } };\n",
  sources: [
    { path: "src/bot.ts", content: "export default defineBot({ tick: () => ({ turn: 0 }) });\n" },
    { path: "package.json", content: '{ "name": "my-snake" }\n' },
  ],
  meta: { cliVersion: "0.1.0", sdkVersion: "0.1.0", message: "first try" },
  ...overrides,
});

async function createBot(token: string, name = "My Snake", slug?: string) {
  const res = await api().createBot(
    request("/api/bots", { method: "POST", token, body: slug ? { name, slug } : { name } }),
  );
  expect(res.status).toBe(201);
  return json<BotInfo>(res);
}

function deploy(
  token: string,
  bot: string,
  body: unknown = deployBody(),
  { headers, limits }: { headers?: Record<string, string>; limits?: Partial<DeployLimits> } = {},
) {
  return api(limits ? { limits } : {}).deploy(
    request(`/api/bots/${bot}/versions`, {
      method: "POST",
      token,
      body,
      ...(headers ? { headers } : {}),
    }),
    bot,
  );
}

const getVersion = (token: string | undefined, bot: string, n: string) =>
  api().getVersion(request(`/api/bots/${bot}/versions/${n}`, token ? { token } : {}), bot, n);

const me = async (token: string) => json<MeResponse>(await api().me(request("/api/me", { token })));

async function expectError(res: Response, status: number, error: ApiErrorBody["error"]) {
  expect(res.status).toBe(status);
  const body = await json<ApiErrorBody>(res);
  expect(body.error).toBe(error);
  expect(body.message).toEqual(expect.any(String));
  return body;
}

const versionCount = async () =>
  (await env.DB.prepare("SELECT count(*) AS n FROM versions").first<{ n: number }>())?.n;

async function r2Keys(bucket: R2Bucket) {
  return (await bucket.list()).objects.map((o) => o.key);
}

/** Nothing of a rejected deploy may be left behind. */
async function expectNothingStored() {
  expect(await versionCount()).toBe(0);
  expect(await r2Keys(env.BUNDLES)).toEqual([]);
  expect(await r2Keys(env.SOURCES)).toEqual([]);
  expect(sent).toEqual([]);
}

// ─── Auth ────────────────────────────────────────────────────────────────────────────────────────

describe("auth: CLI tokens only", () => {
  const endpoints = (token?: string) => {
    const t = token ? { token } : {};
    return [
      () => api().me(request("/api/me", t)),
      () => api().createBot(request("/api/bots", { ...t, method: "POST", body: { name: "x" } })),
      () =>
        api().deploy(
          request("/api/bots/x/versions", { ...t, method: "POST", body: deployBody() }),
          "x",
        ),
      () => api().getVersion(request("/api/bots/x/versions/1", t), "x", "1"),
    ];
  };

  it("rejects requests without a token", async () => {
    for (const call of endpoints()) {
      const res = await call();
      const body = await expectError(res, 401, "unauthorized");
      expect(body.message).toContain("zerosnake login");
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    }
  });

  it("rejects unknown, expired and non-zsk tokens", async () => {
    const { token, userId } = await cliUser();
    await env.DB.prepare("UPDATE cli_tokens SET expires_at = 0 WHERE user_id = ?")
      .bind(userId)
      .run();
    for (const bad of [token, "zsk_unknown", "not-a-cli-token"]) {
      for (const call of endpoints(bad)) await expectError(await call(), 401, "unauthorized");
    }
  });

  it("rejects a web session in both directions", async () => {
    const auth = createAuth({
      DB: env.DB,
      AUTH_KV: env.AUTH_KV,
      BETTER_AUTH_URL: BASE,
      BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
      GITHUB_CLIENT_ID: "id",
      GITHUB_CLIENT_SECRET: "secret",
    });
    const jar = await signInWithGithub(auth);
    const [session] = await webSessions(env.AUTH_KV);
    expect(session).toBeDefined();

    // The session cookie, or the raw session token as a bearer, doesn't open the CLI API.
    for (const call of [
      () => api().me(request("/api/me", { headers: { cookie: jar.header() } })),
      () =>
        api().createBot(
          request("/api/bots", {
            method: "POST",
            body: { name: "x" },
            headers: { cookie: jar.header(), origin: BASE },
          }),
        ),
      () => api().me(request("/api/me", { token: session?.token ?? "" })),
    ]) {
      await expectError(await call(), 401, "unauthorized");
    }
    const browser = await json<ApiErrorBody>(
      await api().me(request("/api/me", { headers: { cookie: jar.header() } })),
    );
    expect(browser.message).toContain("not a browser session");

    // And a CLI token isn't a web session.
    const token = `zsk_${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO cli_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
    )
      .bind(crypto.randomUUID(), session?.userId, await hashToken(token), Date.now() + 86_400_000)
      .run();
    const getSession = await auth.handler(
      new Request(`${BASE}/api/auth/get-session`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(await getSession.json()).toBeNull();
    expect((await api().me(request("/api/me", { token }))).status).toBe(200);
  });
});

async function signInWithGithub(auth: ReturnType<typeof createAuth>) {
  mockGithub({ id: 7, login: "webby", name: "Webby", email: "webby@example.com" });
  const jar = new CookieJar();
  const start = await auth.handler(
    new Request(`${BASE}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ provider: "github", callbackURL: "/welcome" }),
    }),
  );
  jar.store(start);
  const state = new URL((await json<{ url: string }>(start)).url).searchParams.get("state");
  const callback = await auth.handler(
    new Request(`${BASE}/api/auth/callback/github?code=c&state=${state}`, {
      headers: { cookie: jar.header() },
    }),
  );
  jar.store(callback);
  return jar;
}

// ─── Bots ────────────────────────────────────────────────────────────────────────────────────────

describe("POST /api/bots", () => {
  it("creates a bot with a slug made from its name", async () => {
    const { token } = await cliUser();
    const bot = await createBot(token, "  Sneaky Snake 2000!  ");
    expect(bot).toMatchObject({ name: "Sneaky Snake 2000!", slug: "sneaky-snake-2000" });
    expect((await me(token)).bots).toEqual([
      {
        ...bot,
        archived: false,
        activeVersion: null,
        activeQuarantine: null,
        latestVersion: null,
      },
    ]);
  });

  it("takes an explicit slug and checks it", async () => {
    const { token } = await cliUser();
    expect(await createBot(token, "Whatever", "Hunter-1")).toMatchObject({ slug: "hunter-1" });
    for (const body of [
      { name: "" },
      { name: "x".repeat(41) },
      { name: "a\u0000b" },
      { name: "!!!" },
      { name: "ok", slug: "-bad" },
      { name: "ok", slug: "has space" },
      { name: "ok", slug: "x".repeat(33) },
    ]) {
      await expectError(
        await api().createBot(request("/api/bots", { method: "POST", token, body })),
        422,
        "invalid_bot_name",
      );
    }
    await expectError(
      await api().createBot(request("/api/bots", { method: "POST", token, body: { nope: 1 } })),
      400,
      "invalid_request",
    );
  });

  it("refuses a slug the author already uses, returning that bot", async () => {
    const { token } = await cliUser();
    const bot = await createBot(token, "Snake");
    const res = await api().createBot(
      request("/api/bots", { method: "POST", token, body: { name: "SNAKE" } }),
    );
    expect((await expectError(res, 409, "bot_exists")).bot).toEqual(bot);
    // Other authors can use it.
    await createBot((await cliUser()).token, "Snake");
  });

  it("allows 3 bots per author, also under concurrency", async () => {
    const { token } = await cliUser();
    const results = await Promise.all(
      ["a", "b", "c", "d", "e", "f"].map((name) =>
        api().createBot(request("/api/bots", { method: "POST", token, body: { name } })),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 201, 403, 403, 403]);
    const refused = results.find((r) => r.status === 403);
    expect(await json<ApiErrorBody>(refused as Response)).toMatchObject({
      error: "bot_limit_reached",
      limit: 3,
    });
    expect((await me(token)).bots).toHaveLength(3);
  });

  it("reads the bot limit from BOTS_PER_AUTHOR", async () => {
    const { token } = await cliUser();
    const create = (name: string) =>
      api({ vars: { BOTS_PER_AUTHOR: "1" } }).createBot(
        request("/api/bots", { method: "POST", token, body: { name } }),
      );
    expect((await create("one")).status).toBe(201);
    await expectError(await create("two"), 403, "bot_limit_reached");
  });

  it("doesn't count archived bots, keeps their slugs taken and refuses deploys to them", async () => {
    const { token } = await cliUser();
    const create = (name: string) =>
      api().createBot(request("/api/bots", { method: "POST", token, body: { name } }));
    const archived = await createBot(token, "Old");
    await createBot(token, "b");
    await createBot(token, "c");
    await expectError(await create("d"), 403, "bot_limit_reached");
    await env.DB.prepare("UPDATE bots SET archived_at = ? WHERE id = ?")
      .bind(clock.getTime(), archived.id)
      .run();

    expect((await create("d")).status).toBe(201);
    const exists = await expectError(await create("Old"), 409, "bot_exists");
    expect(exists.message).toMatch(/archived/);
    const refused = await expectError(await deploy(token, "old"), 409, "bot_archived");
    expect(refused.bot).toMatchObject({ id: archived.id });
    expect(sent).toEqual([]);
    expect((await me(token)).bots.find((b) => b.id === archived.id)).toMatchObject({
      archived: true,
    });
  });

  it("refuses a deploy whose bot is archived while the body is still uploading", async () => {
    const { token, userId } = await cliUser();
    const bot = await createBot(token, "a");
    const site = createBotAdmin(
      { DB: env.DB, BETTER_AUTH_URL: BASE },
      { getSession: async () => ({ user: { id: userId } }), now: () => clock },
    );
    const bytes = new TextEncoder().encode(JSON.stringify(deployBody()));
    let archived: Awaited<ReturnType<typeof site.archiveBot>> | undefined;
    // Pulled only when the handler reads the body, after its own `archived_at` check: the
    // owner archives the bot on the site mid-upload.
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          archived = await site.archiveBot(
            new Request(`${BASE}/_serverFn/archiveBot`, {
              method: "POST",
              headers: { origin: BASE },
            }),
            { botId: bot.id },
          );
          controller.enqueue(bytes);
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const res = await api().deploy(
      new Request(`${BASE}/api/bots/a/versions`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit),
      "a",
    );

    expect(archived).toMatchObject({ ok: true });
    await expectError(res, 409, "bot_archived");
    expect(await versionCount()).toBe(0);
    expect(sent).toEqual([]);
    expect((await me(token)).quota.deploysToday).toBe(0);
  });
});

// ─── Deploy ──────────────────────────────────────────────────────────────────────────────────────

describe("POST /api/bots/:bot/versions", () => {
  it("stores bundle and sources in R2, creates a validating version and enqueues it", async () => {
    const { token, userId } = await cliUser();
    const bot = await createBot(token);
    const body = deployBody();
    const res = await deploy(token, bot.slug, body);
    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toBe(`/api/bots/${bot.slug}/versions/1`);
    const { version, quota } = await json<DeployResponse>(res);
    expect(version).toMatchObject({
      bot: { id: bot.id, slug: bot.slug },
      n: 1,
      status: "validating",
      report: null,
      meta: body.meta,
    });
    expect(quota).toEqual({
      deploysToday: 1,
      deploysPerDay: 20,
      resetsAt: "2026-10-27T00:00:00.000Z",
    });

    const row = await env.DB.prepare("SELECT * FROM versions WHERE id = ?")
      .bind(version.id)
      .first<{ bundle_key: string; source_key: string; status: string }>();
    expect(row?.status).toBe("validating");
    expect(row?.bundle_key).toMatch(/^[0-9a-f]{64}\.js$/);
    expect(row?.source_key).toMatch(/^[0-9a-f]{64}\.json$/);

    const bundle = await env.BUNDLES.get(row?.bundle_key ?? "");
    expect(await bundle?.text()).toBe(body.bundle);
    expect(bundle?.httpMetadata?.contentType).toContain("javascript");
    const archive = await (await env.SOURCES.get(row?.source_key ?? ""))?.json<SourceArchive>();
    expect(archive).toEqual({
      format: "zerosnake-sources@1",
      // Sorted by path.
      files: [body.sources[1], body.sources[0]],
    });

    expect(sent).toHaveLength(1);
    expect(isCheckJob(sent[0])).toBe(true);
    expect(sent[0]).toEqual({
      v: 1,
      versionId: version.id,
      botId: bot.id,
      ownerId: userId,
      n: 1,
      bundleKey: row?.bundle_key,
      sourceKey: row?.source_key,
      enqueuedAt: expect.any(Number),
    });
  });

  it("accepts the bot id instead of the slug", async () => {
    const { token } = await cliUser();
    const bot = await createBot(token);
    expect((await deploy(token, bot.id)).status).toBe(201);
  });

  it("numbers versions per bot", async () => {
    const { token } = await cliUser();
    const a = await createBot(token, "a");
    const b = await createBot(token, "b");
    const n = async (bot: string) =>
      (await json<DeployResponse>(await deploy(token, bot))).version.n;
    expect([await n("a"), await n("a"), await n("b"), await n("a")]).toEqual([1, 2, 1, 3]);
    expect((await me(token)).bots.map((x) => [x.slug, x.latestVersion?.n])).toEqual([
      [a.slug, 3],
      [b.slug, 1],
    ]);
  });

  it("gives concurrent deploys distinct, consecutive numbers", async () => {
    const { token } = await cliUser();
    await createBot(token, "racer");
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        deploy(token, "racer", deployBody({ bundle: `export const i = ${i};` })),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
    const ns = await Promise.all(
      results.map(async (r) => (await json<DeployResponse>(r)).version.n),
    );
    expect(ns.sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(sent.map((j) => j.n).sort((x, y) => x - y)).toEqual(ns);
  });

  it("only deploys to the caller's own bots", async () => {
    const owner = await cliUser();
    const other = await cliUser();
    const bot = await createBot(owner.token, "mine");
    await expectError(await deploy(other.token, bot.id), 403, "not_bot_owner");
    // By slug it's simply not one of theirs.
    await expectError(await deploy(other.token, bot.slug), 404, "bot_not_found");
    await expectError(await getVersion(other.token, bot.id, "1"), 403, "not_bot_owner");
    await expectNothingStored();
  });

  it("enforces the per-request limits up to the exact limit", async () => {
    const { token } = await cliUser();
    await createBot(token, "big");
    const at = await deploy(
      token,
      "big",
      deployBody({
        bundle: "x".repeat(256 * KiB),
        sources: Array.from({ length: 50 }, (_, i) => ({
          path: `src/f${i}.ts`,
          // 50 files summing to exactly 1 MiB.
          content: "y".repeat(i === 0 ? 1024 * KiB - 49 * 10 : 10),
        })),
      }),
    );
    expect(at.status).toBe(201);
  });

  describe("rejects, storing nothing", () => {
    let token: string;
    beforeEach(async () => {
      ({ token } = await cliUser());
      await createBot(token, "bot");
    });

    it("more than 50 files", async () => {
      const sources = Array.from({ length: 51 }, (_, i) => ({ path: `f${i}.ts`, content: "" }));
      const body = await expectError(
        await deploy(token, "bot", deployBody({ sources })),
        422,
        "too_many_files",
      );
      expect(body).toMatchObject({ limit: 50, actual: 51 });
      await expectNothingStored();
    });

    it("sources over 1 MB, counted in UTF-8 bytes", async () => {
      // 349,526 × 3 bytes = 1 MiB + 2.
      const sources = [{ path: "big.ts", content: "€".repeat(349_526) }];
      const body = await expectError(
        await deploy(token, "bot", deployBody({ sources })),
        422,
        "sources_too_large",
      );
      expect(body).toMatchObject({ limit: 1024 * KiB, actual: 1024 * KiB + 2 });
      expect(body.message).toContain("1 MB");
      await expectNothingStored();
    });

    it("a bundle over 256 KB", async () => {
      const body = await expectError(
        await deploy(token, "bot", deployBody({ bundle: "x".repeat(256 * KiB + 1) })),
        422,
        "bundle_too_large",
      );
      expect(body).toMatchObject({ limit: 256 * KiB, actual: 256 * KiB + 1 });
      await expectNothingStored();
    });

    it.each([
      "../secret.ts",
      "src/../../etc/passwd",
      "/etc/passwd",
      "C:/Windows/x.ts",
      "src\\bot.ts",
      "src//bot.ts",
      "./src/bot.ts",
      "src/./bot.ts",
      "src/",
      "",
      "my file.ts",
      "src/\u0000.ts",
      "naïve.ts",
      `${"a/".repeat(100)}b`,
    ])("the path %j", async (path) => {
      expect(sourcePathProblem(path)).not.toBeNull();
      const body = await expectError(
        await deploy(token, "bot", deployBody({ sources: [{ path, content: "" }] })),
        422,
        "invalid_path",
      );
      expect(body.path).toBe(path);
      await expectNothingStored();
    });

    it("the same path twice, ignoring case", async () => {
      const sources = [
        { path: "src/Bot.ts", content: "a" },
        { path: "src/bot.ts", content: "b" },
      ];
      await expectError(await deploy(token, "bot", deployBody({ sources })), 422, "duplicate_path");
      await expectNothingStored();
    });

    it("malformed requests", async () => {
      const cases: [unknown, number, ApiErrorBody["error"], Record<string, string>?][] = [
        ["{not json", 400, "invalid_request"],
        [{ sources: deployBody().sources }, 400, "invalid_request"],
        [deployBody({ bundle: "" }), 400, "invalid_request"],
        [deployBody({ sources: [] }), 400, "invalid_request"],
        [{ ...deployBody(), meta: { message: "m".repeat(201) } }, 400, "invalid_request"],
        [deployBody(), 415, "unsupported_media_type", { "content-type": "text/plain" }],
      ];
      for (const [body, status, error, headers] of cases) {
        await expectError(
          await deploy(token, "bot", body, headers ? { headers } : {}),
          status,
          error,
        );
      }
      await expectError(await deploy(token, "nope"), 404, "bot_not_found");
      await expectNothingStored();
    });

    it("bodies over the size cap, with or without Content-Length", async () => {
      const limits = { maxBodyBytes: 4 * KiB };
      const big = deployBody({ bundle: "x".repeat(5 * KiB) });
      await expectError(await deploy(token, "bot", big, { limits }), 413, "body_too_large");

      const bytes = new TextEncoder().encode(JSON.stringify(big));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 1024) controller.enqueue(bytes.slice(i, i + 1024));
          controller.close();
        },
      });
      const streamed = new Request(`${BASE}/api/bots/bot/versions`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit);
      expect(streamed.headers.get("content-length")).toBeNull();
      await expectError(await api({ limits }).deploy(streamed, "bot"), 413, "body_too_large");
      await expectNothingStored();
    });
  });

  it("checks the file count before validating every entry", async () => {
    const { token } = await cliUser();
    await createBot(token, "bot");
    const sources = Array.from({ length: 100_000 }, () => ({}));
    const body = await expectError(
      await deploy(token, "bot", { bundle: "x", sources }),
      422,
      "too_many_files",
    );
    expect(body.actual).toBe(100_000);
    await expectNothingStored();
  });
});

// ─── Quota ───────────────────────────────────────────────────────────────────────────────────────

describe("daily deploy quota", () => {
  it("allows 20 deploys per author per UTC day, across bots, rejected ones included", async () => {
    const { token } = await cliUser();
    await createBot(token, "a");
    await createBot(token, "b");
    expect((await deploy(token, "a")).status).toBe(201);
    expect((await deploy(token, "b")).status).toBe(201);
    // 18 earlier deploys today and some yesterday, straight into D1 to keep the test fast.
    const insert = (bot: string, n: number, at: Date) =>
      env.DB.prepare(
        `INSERT INTO versions
           (id, bot_id, n, status, bundle_key, source_key, enqueued_at, created_at, updated_at)
         SELECT ?, id, ?, 'rejected', 'b', 's', ?3, ?3, ?3 FROM bots WHERE slug = ?4`,
      ).bind(crypto.randomUUID(), n, at.getTime(), bot);
    await env.DB.batch([
      ...Array.from({ length: 18 }, (_, i) => insert(i % 2 ? "a" : "b", 10 + i, clock)),
      ...Array.from({ length: 5 }, (_, i) =>
        insert("a", 100 + i, new Date("2026-10-25T23:59:59Z")),
      ),
    ]);
    const body = await expectError(await deploy(token, "a"), 429, "quota_exceeded");
    expect(body.quota).toEqual({
      deploysToday: 20,
      deploysPerDay: 20,
      resetsAt: "2026-10-27T00:00:00.000Z",
    });
    expect(body.message).toContain("00:00 UTC");
    expect((await me(token)).quota.deploysToday).toBe(20);

    // Someone else's quota is their own.
    const other = await cliUser();
    await createBot(other.token, "a");
    expect((await deploy(other.token, "a")).status).toBe(201);

    // Next UTC day.
    clock = new Date("2026-10-27T00:00:01Z");
    expect((await deploy(token, "a")).status).toBe(201);
    expect((await me(token)).quota).toMatchObject({ deploysToday: 1 });
  });

  it("holds under concurrency", async () => {
    const { token } = await cliUser();
    await createBot(token, "bot");
    const limits = { deploysPerDay: 3 };
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        deploy(token, "bot", deployBody({ bundle: `export const i = ${i};` }), { limits }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 201, 429, 429, 429, 429, 429]);
    expect(await versionCount()).toBe(3);
    expect(sent).toHaveLength(3);
  });

  it("reads the quota from DEPLOYS_PER_DAY", async () => {
    const { token } = await cliUser();
    await createBot(token, "bot");
    const limited = () =>
      api({ vars: { DEPLOYS_PER_DAY: "1" } }).deploy(
        request("/api/bots/bot/versions", { method: "POST", token, body: deployBody() }),
        "bot",
      );
    expect((await limited()).status).toBe(201);
    await expectError(await limited(), 429, "quota_exceeded");
    expect(api({ vars: { DEPLOYS_PER_DAY: "junk" } }).limits.deploysPerDay).toBe(20);
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────────────────────────

describe("Idempotency-Key", () => {
  const key = "0b7c1f5e-2d0a-4c39-9e5b-0d6a3b1f2e44";

  it("turns a retry into the same version without using quota", async () => {
    const { token } = await cliUser();
    await createBot(token, "bot");
    const headers = { "idempotency-key": key };
    const first = await deploy(token, "bot", deployBody(), { headers });
    expect(first.status).toBe(201);
    const retry = await deploy(token, "bot", deployBody(), { headers });
    expect(retry.status).toBe(200);
    const a = await json<DeployResponse>(first);
    const b = await json<DeployResponse>(retry);
    expect(b.version).toEqual(a.version);
    expect(b.quota.deploysToday).toBe(1);
    expect(sent).toHaveLength(1);

    // A retry still works once the quota is used up.
    expect(
      (await deploy(token, "bot", deployBody(), { headers, limits: { deploysPerDay: 1 } })).status,
    ).toBe(200);
  });

  it("refuses the same key for different content", async () => {
    const { token } = await cliUser();
    await createBot(token, "bot");
    const headers = { "idempotency-key": key };
    expect((await deploy(token, "bot", deployBody(), { headers })).status).toBe(201);
    await expectError(
      await deploy(token, "bot", deployBody({ bundle: "export {};" }), { headers }),
      409,
      "idempotency_conflict",
    );
    // Without a key, the same content is a new version.
    expect((await json<DeployResponse>(await deploy(token, "bot"))).version.n).toBe(2);
  });

  it("makes one version from concurrent retries", async () => {
    const { token } = await cliUser();
    await createBot(token, "bot");
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        deploy(token, "bot", deployBody(), { headers: { "idempotency-key": key } }),
      ),
    );
    // The others either see it in flight (409) or already queued (200).
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.every((s) => [200, 201, 409].includes(s))).toBe(true);
    expect(await versionCount()).toBe(1);
    expect(sent).toHaveLength(1);
    const retry = await deploy(token, "bot", deployBody(), { headers: { "idempotency-key": key } });
    expect(retry.status).toBe(200);
    expect((await json<DeployResponse>(retry)).version.n).toBe(1);
  });

  it("is scoped to the bot and validated", async () => {
    const { token } = await cliUser();
    await createBot(token, "a");
    await createBot(token, "b");
    const headers = { "idempotency-key": key };
    expect((await deploy(token, "a", deployBody(), { headers })).status).toBe(201);
    expect((await deploy(token, "b", deployBody(), { headers })).status).toBe(201);
    await expectError(
      await deploy(token, "a", deployBody(), { headers: { "idempotency-key": "short" } }),
      400,
      "invalid_request",
    );
  });
});

// ─── Status ──────────────────────────────────────────────────────────────────────────────────────

describe("GET /api/bots/:bot/versions/:n", () => {
  it("returns the status, then the report the checks consumer writes", async () => {
    const { token } = await cliUser();
    const bot = await createBot(token, "bot");
    const { version } = await json<DeployResponse>(await deploy(token, "bot"));

    const pending = await getVersion(token, "bot", "1");
    expect(pending.status).toBe(200);
    expect(await json<VersionInfo>(pending)).toEqual(version);

    // What apps/arena (#22) does when the checks fail.
    const report: CheckReport = {
      ok: false,
      checks: [{ name: "loads", ok: false, message: "SyntaxError: Unexpected token" }],
    };
    await env.DB.prepare("UPDATE versions SET status = 'rejected', report = ? WHERE id = ?")
      .bind(JSON.stringify(report), version.id)
      .run();
    expect(await json<VersionInfo>(await getVersion(token, bot.id, "1"))).toMatchObject({
      status: "rejected",
      report,
    });

    for (const n of ["2", "0", "-1", "1.5", "abc", "99999999999"]) {
      await expectError(await getVersion(token, "bot", n), 404, "version_not_found");
    }
    await expectError(await getVersion(token, "nope", "1"), 404, "bot_not_found");
  });
});

describe("GET /api/me", () => {
  it("shows the user, their bots' versions, quota and limits", async () => {
    const { token, userId } = await cliUser("ada");
    const bot = await createBot(token, "Ada Bot");
    await deploy(token, "ada-bot");
    await deploy(token, "ada-bot");
    await env.DB.prepare("UPDATE versions SET status = 'ready' WHERE n = 1").run();

    const res = await me(token);
    expect(res.user).toEqual({ id: userId, username: "ada", name: "ada", image: null });
    expect(res.bots).toEqual([
      {
        ...bot,
        archived: false,
        activeVersion: 1,
        activeQuarantine: null,
        latestVersion: { n: 2, status: "validating", createdAt: clock.toISOString() },
      },
    ]);

    // The arena quarantined the active version (apps/arena's `recordQuarantine`).
    const at = Date.parse("2026-10-26T13:00:00.000Z");
    await env.DB.prepare(
      "UPDATE versions SET quarantined_at = ?, quarantine_reason = 'kept hitting the CPU limit' WHERE n = 1",
    )
      .bind(at)
      .run();
    const quarantine = { at: new Date(at).toISOString(), reason: "kept hitting the CPU limit" };
    expect((await me(token)).bots[0]?.activeQuarantine).toEqual(quarantine);
    expect(await json<VersionInfo>(await getVersion(token, "ada-bot", "1"))).toMatchObject({
      status: "ready",
      quarantine,
    });
    expect(res.quota).toMatchObject({ deploysToday: 2, deploysPerDay: 20 });
    expect(res.limits).toMatchObject({
      maxSourceFiles: 50,
      maxSourceBytes: 1024 * KiB,
      maxBundleBytes: 256 * KiB,
      deploysPerDay: 20,
      botsPerAuthor: 3,
    });
  });
});

describe("deploy quota", () => {
  it("counts rollbacks made on the site", async () => {
    const { token, userId } = await cliUser();
    const bot = await createBot(token, "a");
    expect((await deploy(token, "a", deployBody(), { limits: { deploysPerDay: 2 } })).status).toBe(
      201,
    );
    const [version] = sent;
    await env.DB.prepare(
      `INSERT INTO activations (id, owner_id, bot_id, kind, version_id, created_at)
       VALUES (?, ?, ?, 'activate', ?, ?)`,
    )
      .bind(crypto.randomUUID(), userId, bot.id, version?.versionId, clock.getTime())
      .run();
    expect((await me(token)).quota.deploysToday).toBe(2);
    await expectError(
      await deploy(token, "a", deployBody({ bundle: "export const tick = () => 1;" }), {
        limits: { deploysPerDay: 2 },
      }),
      429,
      "quota_exceeded",
    );
  });
});

// ─── Failures ────────────────────────────────────────────────────────────────────────────────────

describe("interrupted and failed deploys", () => {
  const key = "c1d2e3f4-0000-4000-8000-000000000001";
  const headers = { "idempotency-key": key };
  let token: string;

  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    ({ token } = await cliUser());
    await createBot(token, "bot");
  });

  const version = async (n: number) => json<VersionInfo>(await getVersion(token, "bot", `${n}`));

  it("answers a retry with 409 while the first attempt is queueing, then replays it", async () => {
    const hold = holdNextSend();
    const first = deploy(token, "bot", deployBody(), { headers });
    await hold.reached;
    await expectError(
      await deploy(token, "bot", deployBody(), { headers }),
      409,
      "deploy_in_progress",
    );
    hold.release();
    expect((await first).status).toBe(201);
    const retry = await deploy(token, "bot", deployBody(), { headers });
    expect(retry.status).toBe(200);
    expect((await json<DeployResponse>(retry)).version.n).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("never reports success for a deploy whose queueing then fails", async () => {
    const hold = holdNextSend();
    const first = deploy(token, "bot", deployBody(), { headers });
    await hold.reached;
    // The CLI timed out and retries while the first attempt is still sending.
    await expectError(
      await deploy(token, "bot", deployBody(), { headers }),
      409,
      "deploy_in_progress",
    );
    hold.fail();
    await expectError(await first, 503, "unavailable");

    // The version stays visible, rejected with the reason, and out of the quota.
    expect(await version(1)).toMatchObject({
      status: "rejected",
      report: {
        ok: false,
        checks: [{ name: "deploy", ok: false, message: expect.stringContaining("queued") }],
      },
    });
    expect((await me(token)).quota.deploysToday).toBe(0);

    // The key is free again: the next retry deploys anew.
    const retry = await deploy(token, "bot", deployBody(), { headers });
    expect(retry.status).toBe(201);
    expect((await json<DeployResponse>(retry)).version.n).toBe(2);
    expect(sent.map((j) => j.n)).toEqual([2]);
    expect((await me(token)).quota.deploysToday).toBe(1);
  });

  it("takes over a deploy stuck before queueing for over a minute", async () => {
    const hold = holdNextSend();
    const first = deploy(token, "bot", deployBody(), { headers });
    await hold.reached;
    clock = new Date(clock.getTime() + 61_000);
    const retry = await deploy(token, "bot", deployBody(), { headers });
    expect(retry.status).toBe(201);
    expect((await json<DeployResponse>(retry)).version.n).toBe(2);

    // The first attempt's send goes through late; it was replaced, so it doesn't claim success
    // and its job points at a rejected version, which the consumer skips.
    hold.release();
    await expectError(await first, 503, "unavailable");
    expect(await version(1)).toMatchObject({ status: "rejected" });
    expect(await version(2)).toMatchObject({ status: "validating" });
    expect(sent.map((j) => j.n).sort()).toEqual([1, 2]);
    expect((await me(token)).quota.deploysToday).toBe(1);
  });

  it("rejects the version without queueing it when the upload fails", async () => {
    faults.upload = true;
    await expectError(await deploy(token, "bot"), 503, "unavailable");
    expect(await version(1)).toMatchObject({
      status: "rejected",
      report: { checks: [{ message: expect.stringContaining("stored") }] },
    });
    expect(sent).toEqual([]);
    faults.upload = false;
    expect((await json<DeployResponse>(await deploy(token, "bot"))).version.n).toBe(2);
    expect((await me(token)).quota.deploysToday).toBe(1);
  });

  it("rejects the version when queueing fails, without using quota", async () => {
    faults.queue = true;
    await expectError(await deploy(token, "bot"), 503, "unavailable");
    expect(await version(1)).toMatchObject({ status: "rejected" });
    expect((await me(token)).quota.deploysToday).toBe(0);
    faults.queue = false;
    expect((await deploy(token, "bot")).status).toBe(201);
  });

  it("recovers on retry when even marking the failure fails", async () => {
    faults.queue = true;
    faults.abandon = true;
    await expectError(await deploy(token, "bot", deployBody(), { headers }), 503, "unavailable");
    expect(await version(1)).toMatchObject({ status: "validating" });
    faults.queue = false;
    faults.abandon = false;
    // Looks in flight at first; after a minute a retry takes it over.
    await expectError(
      await deploy(token, "bot", deployBody(), { headers }),
      409,
      "deploy_in_progress",
    );
    clock = new Date(clock.getTime() + 61_000);
    const retry = await deploy(token, "bot", deployBody(), { headers });
    expect(retry.status).toBe(201);
    expect((await json<DeployResponse>(retry)).version.n).toBe(2);
    expect(await version(1)).toMatchObject({ status: "rejected" });
  });

  it("turns unexpected errors into a generic JSON 500", async () => {
    faults.db = true;
    for (const res of [await api().me(request("/api/me", { token })), await deploy(token, "bot")]) {
      const body = await expectError(res, 500, "internal_error");
      expect(body.message).not.toContain("D1");
    }
  });
});
