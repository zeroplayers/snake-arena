/**
 * The replay page's trace panel (`getReplayTrace` → `replayTrace`): only the web session of the
 * life's bot owner gets the trace; no session, someone else's, or a CLI token get nothing of it.
 */
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "../db";
import { type ReplayTrace, replayTrace } from "../queries/trace";
import type { LifeTrace } from "../shared";
import { signUp, type TestAccount } from "../test/accounts";
import { createTestPlatform, type TestPlatformEnv } from "../test/d1";
import { type Auth, createAuth } from "./auth";
import { hashToken } from "./cli-auth";

const BASE = "http://localhost:3000";
const KEY = "2026-10-27/life-ada-1.json.gz";

let platform: Awaited<ReturnType<typeof createTestPlatform>>;
let env: TestPlatformEnv;
let auth: Auth;
let ada: TestAccount;
let bob: TestAccount;

const TRACE = {
  format: 1,
  lifeId: "life-ada-1",
  versionId: "v-ada",
  roomId: "room-1",
  startTick: 10,
  endTick: 20,
  cause: "wall",
  killer: null,
  budget: { ops: 100, work: 1e8, logBytes: 1024 },
  totals: {
    ticks: 10,
    timeouts: 0,
    errors: 0,
    skipped: 0,
    maxWork: 5,
    sumWork: 20,
    maxOps: 1,
    logTicks: 1,
    logBytes: 13,
  },
  load: { log: ["secret plan"] },
  restarts: [],
  sampleEvery: 1,
  sampled: [],
  events: [],
  full: [],
} satisfies LifeTrace;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  platform = await createTestPlatform();
  env = platform.env;
  auth = createAuth({
    DB: env.DB,
    AUTH_KV: env.AUTH_KV,
    BETTER_AUTH_URL: BASE,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    GITHUB_CLIENT_ID: "test-client-id",
    GITHUB_CLIENT_SECRET: "test-client-secret",
  });
  ada = await signUp(auth, env.DB, BASE, "ada", 1);
  bob = await signUp(auth, env.DB, BASE, "bob", 2);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO bots (id, owner_id, name, slug) VALUES (?, ?, ?, ?)").bind(
      "bot-ada",
      ada.id,
      "snake",
      "snake",
    ),
    env.DB.prepare(
      `INSERT INTO versions (id, bot_id, n, status, bundle_key, source_key)
       VALUES ('v-ada', 'bot-ada', 1, 'ready', 'b', 's')`,
    ),
    env.DB.prepare(
      `INSERT INTO lives (id, version_id, room, start_tick, end_tick, score, length_max, kills,
         death_cause, killer, replay_key, trace_key, started_at, ended_at)
       VALUES (?, 'v-ada', 'room-1', 10, 20, 7, 30, 0, 'wall', NULL, 'room-1/0.zsr', ?, 1, 2)`,
    ).bind("life-ada-1", KEY),
  ]);
  await env.TRACES.put(KEY, gzipSync(JSON.stringify(TRACE)));
}, 30_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await platform.dispose();
});

function read(headers: HeadersInit, lifeId = "life-ada-1"): Promise<ReplayTrace> {
  return replayTrace(
    {
      getSession: (input) => auth.api.getSession(input),
      db: createDb(env.DB),
      bucket: env.TRACES,
    },
    new Headers(headers),
    lifeId,
  );
}

describe("replayTrace (the replay page's trace panel)", () => {
  it("gives the bot's owner the trace", async () => {
    expect(await read({ cookie: ada.jar.header() })).toEqual({
      status: "ok",
      trace: { ...TRACE, killerName: null, hasReplay: true },
    });
    expect(await read({ cookie: ada.jar.header() }, "nope")).toEqual({ status: "none" });
  });

  it("gives everyone else nothing of it", async () => {
    const results = [
      await read({}),
      await read({ cookie: "better-auth.session_token=forged.value" }),
      await read({ cookie: bob.jar.header() }),
    ];
    expect(results).toEqual([
      { status: "private", signedIn: false },
      { status: "private", signedIn: false },
      { status: "private", signedIn: true },
    ]);
    expect(JSON.stringify(results)).not.toContain("secret plan");
  });

  it("takes a web session only: the owner's CLI token isn't one", async () => {
    const token = `zsk_${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO cli_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
    )
      .bind(crypto.randomUUID(), ada.id, await hashToken(token), Date.now() + 86_400_000)
      .run();
    expect(await read({ authorization: `Bearer ${token}` })).toEqual({
      status: "private",
      signedIn: false,
    });
  });
});
