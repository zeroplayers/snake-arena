/**
 * `login` → `deploy` → `status` → `logs` → `logout` against the real site API: apps/web's Better
 * Auth (device flow, CLI tokens) and CLI API on a real D1, R2 and queue producer (wrangler's
 * platform proxy, as in apps/web's tests), served over HTTP on 127.0.0.1.
 *
 * The server maps paths to handlers the way apps/web's file routes do (`src/routes/api/**`); the
 * route tree itself needs the TanStack Start runtime. Two things nobody can do yet are done here
 * by hand, on the database:
 * - approving the device code (the person on `/device`, signed in with GitHub);
 * - the checks consumer (zeroplayers/snake-arena#22): it moves queued versions to `ready`.
 *
 * apps/web is loaded by path at run time so this package's typecheck doesn't pull in the site.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "./cli.ts";
import type { Remote } from "./remote/api.ts";
import { Credentials } from "./remote/config.ts";
import { captureIo, cleanUp, makeProject, PASSING_BOT, TUNING } from "./testing/project.ts";

interface D1 {
  prepare(sql: string): {
    bind(...values: unknown[]): { run(): Promise<unknown>; all<T>(): Promise<{ results: T[] }> };
    run(): Promise<unknown>;
    all<T>(): Promise<{ results: T[] }>;
  };
}
type Handle = (request: Request, ...params: string[]) => Promise<Response>;
interface Web {
  platform: {
    env: { DB: D1; TRACES: { put(key: string, body: Uint8Array): Promise<unknown> } } & Record<
      string,
      unknown
    >;
    dispose(): Promise<void>;
  };
  auth: { handler(request: Request): Promise<Response> };
  cliApi: {
    me: Handle;
    createBot: Handle;
    deploy: Handle;
    getVersion: Handle;
    listLives: Handle;
    getTrace: Handle;
  };
  profile(username: string): Promise<unknown>;
}

const web = (path: string) =>
  fileURLToPath(new URL(`../../../apps/web/src/${path}`, import.meta.url));

async function loadWeb(base: string): Promise<Web> {
  const { createTestPlatform } = await import(web("test/d1.ts"));
  const { createAuth } = await import(web("server/auth.ts"));
  const { createCliApi } = await import(web("server/cli-api.ts"));
  const { createDb } = await import(web("db/index.ts"));
  const { getProfile } = await import(web("db/queries.ts"));
  const platform = await createTestPlatform();
  const db = createDb(platform.env.DB);
  return {
    platform,
    auth: createAuth({
      DB: platform.env.DB,
      BETTER_AUTH_URL: base,
      BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
      GITHUB_CLIENT_ID: "test-client-id",
      GITHUB_CLIENT_SECRET: "test-client-secret",
    }),
    cliApi: createCliApi(platform.env),
    profile: (username) => getProfile(db, username),
  };
}

/** Requests to the server; `loseNextDeployAnswer` drops the connection after a deploy is handled. */
const seen: { method: string; path: string; key: string | null }[] = [];
let loseNextDeployAnswer = false;

async function route(w: Web, request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  const m = request.method;
  if (pathname.startsWith("/api/auth/")) return w.auth.handler(request);
  if (m === "GET" && pathname === "/api/me") return w.cliApi.me(request);
  if (m === "POST" && pathname === "/api/bots") return w.cliApi.createBot(request);
  let p = /^\/api\/bots\/([^/]+)\/versions$/.exec(pathname);
  if (m === "POST" && p?.[1]) return w.cliApi.deploy(request, decodeURIComponent(p[1]));
  p = /^\/api\/bots\/([^/]+)\/versions\/([^/]+)$/.exec(pathname);
  if (m === "GET" && p?.[1] && p[2])
    return w.cliApi.getVersion(request, decodeURIComponent(p[1]), p[2]);
  p = /^\/api\/bots\/([^/]+)\/versions\/([^/]+)\/lives$/.exec(pathname);
  if (m === "GET" && p?.[1] && p[2])
    return w.cliApi.listLives(request, decodeURIComponent(p[1]), p[2]);
  p = /^\/api\/lives\/([^/]+)\/trace$/.exec(pathname);
  if (m === "GET" && p?.[1]) return w.cliApi.getTrace(request, decodeURIComponent(p[1]));
  p = /^\/api\/users\/([^/]+)$/.exec(pathname);
  if (m === "GET" && p?.[1]) {
    const profile = await w.profile(decodeURIComponent(p[1]));
    return profile
      ? Response.json(profile)
      : Response.json({ error: "not_found" }, { status: 404 });
  }
  return new Response("<!doctype html><title>Not found</title>", {
    status: 404,
    headers: { "content-type": "text/html" },
  });
}

function serve(w: Web): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(name, value);
    }
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method ?? "GET",
      headers,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    seen.push({
      method: request.method,
      path: new URL(request.url).pathname,
      key: headers.get("idempotency-key"),
    });
    const response = await route(w, request);
    const body = Buffer.from(await response.arrayBuffer());
    if (loseNextDeployAnswer && request.method === "POST" && /\/versions$/.test(request.url)) {
      loseNextDeployAnswer = false;
      req.socket.destroy();
      return;
    }
    res.statusCode = response.status;
    response.headers.forEach((value, name) => {
      if (name !== "set-cookie") res.setHeader(name, value);
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) res.setHeader("set-cookie", cookies);
    res.end(body);
  });
}

let w: Web;
let server: Server;
let base: string;
let consumer: ReturnType<typeof setInterval>;
let consuming: Promise<unknown> = Promise.resolve();
const configDir = makeProject({});
const project = makeProject({
  "package.json": JSON.stringify({ name: "my-snake" }),
  "src/bot.ts": PASSING_BOT,
  "src/tuning.ts": TUNING,
});

beforeAll(async () => {
  server = createServer();
  // Find a free port first: Better Auth needs its base URL up front.
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  base = `http://127.0.0.1:${port}`;
  w = await loadWeb(base);
  server = serve(w);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  await w.platform.env.DB.prepare(
    "INSERT INTO users (id, name, email, username) VALUES ('u1', 'Ada', 'ada@example.com', 'ada')",
  ).run();

  // Stand-in for the checks consumer (#22): queued versions pass.
  const report = JSON.stringify({
    ok: true,
    checks: [{ name: "loads", ok: true }],
    qualificationScore: 40,
  });
  consumer = setInterval(() => {
    consuming = w.platform.env.DB.prepare(
      "UPDATE versions SET status = 'ready', report = ?, updated_at = ? WHERE status = 'validating' AND enqueued_at IS NOT NULL",
    )
      .bind(report, Date.now())
      .run();
  }, 50);
}, 60_000);

afterAll(async () => {
  clearInterval(consumer);
  await consuming;
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await w?.platform.dispose();
  cleanUp();
});

function remote(): Remote {
  let approval: Promise<unknown> = Promise.resolve();
  return {
    fetch: globalThis.fetch,
    env: { ZEROSNAKE_URL: base, ZEROSNAKE_CONFIG_DIR: configDir },
    // Polls without the real intervals; the device flow waits for the "browser" to approve.
    sleep: async () => {
      await approval;
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
    // The person approves the code on /device (signed in as @ada).
    openBrowser: (url) => {
      const code = new URL(url).searchParams.get("user_code");
      approval = w.platform.env.DB.prepare(
        "UPDATE device_codes SET status = 'approved', user_id = 'u1' WHERE user_code = ?",
      )
        .bind(code)
        .run();
    },
    now: Date.now,
  };
}

async function run(argv: string[]) {
  const io = captureIo(project);
  const code = await main(argv, io, remote());
  return { code, out: io.stdout(), err: io.stderr() };
}

describe("the CLI against the real API", () => {
  it("logs in, deploys, shows status and logs, and logs out", async () => {
    const login = await run(["login"]);
    expect(login.code, login.err).toBe(0);
    expect(login.out).toContain(`Logged in to ${base} as @ada.`);
    const token = new Credentials(configDir).get(base)?.token ?? "";
    expect(token).toMatch(/^zsk_/);
    expect(`${login.out}${login.err}`).not.toContain(token);

    // The first upload is handled but its answer is lost: the retry, with the same
    // Idempotency-Key, gets that version back instead of making another.
    loseNextDeployAnswer = true;
    const deploy = await run(["deploy", "--create", "-m", "hello arena"]);
    expect(deploy.code, `${deploy.out}\n${deploy.err}`).toBe(0);
    expect(deploy.out).toContain("created the bot my-snake");
    expect(deploy.out).toContain("uploaded my-snake v1");
    expect(deploy.out).toContain("my-snake v1 passed the checks and is live in the arena.");
    expect(deploy.out).toContain(`${base}/@ada/my-snake?v=1`);
    expect(deploy.err).toContain("Upload didn't go through");
    const uploads = seen.filter((r) => r.method === "POST" && r.path.endsWith("/versions"));
    expect(uploads).toHaveLength(2);
    expect(uploads[0]?.key).toBeTruthy();
    expect(uploads[1]?.key).toBe(uploads[0]?.key);
    const { results: versions } = await w.platform.env.DB.prepare(
      "SELECT n, status, meta FROM versions",
    ).all<{ n: number; status: string; meta: string }>();
    expect(versions).toEqual([
      { n: 1, status: "ready", meta: expect.stringContaining("hello arena") },
    ]);

    // The arena plays it (#23) and the rating job rates it (#26).
    const { results: rows } = await w.platform.env.DB.prepare("SELECT id FROM versions").all<{
      id: string;
    }>();
    const versionId = rows[0]?.id;
    await w.platform.env.DB.prepare(
      "INSERT INTO ratings (version_id, mean, ci, n_lives, updated_at) VALUES (?, 250.5, 20.25, 40, ?)",
    )
      .bind(versionId, Date.now())
      .run();
    await w.platform.env.DB.prepare(
      "INSERT INTO lives (id, version_id, room, start_tick) VALUES ('l1', ?, 'r1', 0), ('l2', ?, 'r1', 10)",
    )
      .bind(versionId, versionId)
      .run();

    const status = await run(["status"]);
    expect(status.code, status.err).toBe(0);
    expect(status.out).toContain(`Logged in to ${base} as @ada`);
    expect(status.out).toMatch(/active\s+v1/);
    expect(status.out).toContain("250.5 ± 20.3 over 40 lives · ranked");
    expect(status.out).toContain("2 played");
    expect(status.out).toMatch(/Deploys today: 1 of 20, 19 left/);

    const logs = await run(["logs"]);
    expect(logs.code, logs.err).toBe(0);
    expect(logs.out).toContain("my-snake v1 · ready (active)");
    expect(logs.out).toContain("✓ loads");
    // Neither life has ended.
    expect(logs.out).toContain("No lives yet.");

    // A life ends and the room writes its trace (#25).
    const trace = {
      format: 1,
      lifeId: "l3",
      versionId,
      roomId: "r1",
      startTick: 20,
      endTick: 25,
      cause: "wall",
      killer: null,
      budget: { ops: 10, work: 10_000_000, logBytes: 1024 },
      totals: {
        ticks: 5,
        timeouts: 0,
        errors: 0,
        skipped: 0,
        maxWork: 1_000_000,
        sumWork: 2_000_000,
        maxOps: 1,
        logTicks: 1,
        logBytes: 12,
      },
      load: { log: [] },
      restarts: [],
      sampleEvery: 1,
      sampled: [],
      events: [],
      full: [
        {
          tick: 24,
          lifeTick: 4,
          turn: 1,
          boost: true,
          outcome: "ok",
          work: 1_000_000,
          ops: 1,
          log: ["edge is close"],
          seen: {
            x: 99,
            y: 0,
            angle: 0,
            length: 10,
            wall: 0.5,
            snakes: 0,
            food: 0,
            nearest: null,
            foodDist: null,
          },
        },
      ],
    };
    await w.platform.env.TRACES.put("2026-10-27/l3.json.gz", gzipSync(JSON.stringify(trace)));
    await w.platform.env.DB.prepare(
      `INSERT INTO lives (id, version_id, room, start_tick, end_tick, death_cause, trace_key,
         started_at, ended_at) VALUES ('l3', ?, 'r1', 20, 25, 'wall', '2026-10-27/l3.json.gz', ?, ?)`,
    )
      .bind(versionId, Date.now() - 1000, Date.now())
      .run();
    const deaths = await run(["logs", "--deaths"]);
    expect(deaths.code, deaths.err).toBe(0);
    expect(deaths.out).toContain("hit the wall");
    expect(deaths.out).toContain("Life l3: hit the wall at room tick 25, after 5 ticks");
    expect(deaths.out).toContain("[4] head (99, 0) angle 0 length 10 wall 0.5");
    expect(deaths.out).toContain("log: edge is close");

    const logout = await run(["logout"]);
    expect(logout.code).toBe(0);
    expect(logout.err).toBe("");
    const { results: tokens } = await w.platform.env.DB.prepare("SELECT id FROM cli_tokens").all();
    expect(tokens).toEqual([]);
    expect((await run(["status"])).err).toContain("You're not logged in");
  }, 60_000);
});
