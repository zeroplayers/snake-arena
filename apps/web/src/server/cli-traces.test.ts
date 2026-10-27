/**
 * The CLI API's lives and traces (#25): `GET /api/bots/:bot/versions/:n/lives` and
 * `GET /api/lives/:id/trace`, which only the life's bot owner may read.
 */
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiErrorBody, LifeTrace, LivesResponse } from "../shared";
import { createTestPlatform, type TestPlatformEnv } from "../test/d1";
import { createCliApi } from "./cli-api";
import { hashToken } from "./cli-auth";

let platform: Awaited<ReturnType<typeof createTestPlatform>>;
let env: TestPlatformEnv;
let ada: string;
let bob: string;

const TRACE: LifeTrace = {
  format: 1,
  lifeId: "life-ada-1",
  versionId: "v-ada",
  roomId: "room-1",
  startTick: 10,
  endTick: 20,
  cause: "collision",
  killer: "v-bob",
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
    logBytes: 5,
  },
  load: { log: [] },
  restarts: [],
  sampleEvery: 1,
  sampled: [],
  events: [],
  full: [
    {
      tick: 19,
      lifeTick: 9,
      turn: 0.5,
      boost: false,
      outcome: "ok",
      work: 5,
      ops: 1,
      log: ["hello"],
      seen: {
        x: 1,
        y: 2,
        angle: 0,
        length: 10,
        wall: 50,
        snakes: 1,
        food: 0,
        nearest: { id: "life-bob-1", author: "bob", gap: 0.1, length: 30, head: true },
        foodDist: null,
      },
    },
  ],
};

async function user(username: string): Promise<string> {
  const token = `zsk_${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, name, email, username) VALUES (?, ?, ?, ?)").bind(
      username,
      username,
      `${username}@example.com`,
      username,
    ),
    env.DB.prepare(
      "INSERT INTO cli_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), username, await hashToken(token), Date.now() + 86_400_000),
    env.DB.prepare("INSERT INTO bots (id, owner_id, name, slug) VALUES (?, ?, ?, ?)").bind(
      `bot-${username}`,
      username,
      `${username}'s snake`,
      "snake",
    ),
    env.DB.prepare(
      `INSERT INTO versions (id, bot_id, n, status, bundle_key, source_key)
       VALUES (?, ?, 1, 'ready', 'b', 's')`,
    ).bind(`v-${username}`, `bot-${username}`),
  ]);
  return token;
}

async function life(id: string, version: string, traceKey: string | null, endedAt: number) {
  await env.DB.prepare(
    `INSERT INTO lives (id, version_id, room, start_tick, end_tick, score, length_max, kills,
       death_cause, killer, replay_key, trace_key, started_at, ended_at)
     VALUES (?, ?, 'room-1', 10, 20, 7, 30, 0, 'collision', 'v-bob', 'room-1/0.zsr', ?, ?, ?)`,
  )
    .bind(id, version, traceKey, endedAt - 1000, endedAt)
    .run();
}

beforeAll(async () => {
  platform = await createTestPlatform();
  env = platform.env;
  ada = await user("ada");
  bob = await user("bob");
  await life("life-ada-1", "v-ada", "2026-10-27/life-ada-1.json.gz", 3000);
  await life("life-ada-2", "v-ada", null, 2000);
  await life("life-ada-3", "v-ada", "2026-10-10/life-ada-3.json.gz", 1000);
  await env.TRACES.put("2026-10-27/life-ada-1.json.gz", gzipSync(JSON.stringify(TRACE)));
}, 30_000);

afterAll(() => platform.dispose());

const api = () => createCliApi(env);
const get = (path: string, token?: string) =>
  new Request(`http://localhost${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
const trace = (id: string, token?: string) =>
  api().getTrace(get(`/api/lives/${id}/trace`, token), id);

describe("GET /api/lives/:id/trace", () => {
  it("gives the owner the trace, killer named", async () => {
    const res = await trace("life-ada-1", ada);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ...TRACE, killerName: "@bob/snake v1" });
  });

  it("refuses everyone else", async () => {
    const other = await trace("life-ada-1", bob);
    expect(other.status).toBe(403);
    const body = (await other.json()) as ApiErrorBody;
    expect(body.error).toBe("not_life_owner");
    expect(JSON.stringify(body)).not.toContain("hello");
    expect((await trace("life-ada-1")).status).toBe(401);
  });

  it("tells missing lives, unrecorded traces and expired ones apart", async () => {
    const codes = async (id: string) => {
      const res = await trace(id, ada);
      return [res.status, ((await res.json()) as ApiErrorBody).error];
    };
    expect(await codes("nope")).toEqual([404, "life_not_found"]);
    expect(await codes("life-ada-2")).toEqual([404, "trace_not_found"]);
    expect(await codes("life-ada-3")).toEqual([410, "trace_expired"]);
  });
});

describe("GET /api/bots/:bot/versions/:n/lives", () => {
  const lives = (token: string, bot = "snake", query = "") =>
    api().listLives(get(`/api/bots/${bot}/versions/1/lives${query}`, token), bot, "1");

  it("lists the version's lives latest first, killers named, traces flagged", async () => {
    const res = await lives(ada);
    expect(res.status).toBe(200);
    const body = (await res.json()) as LivesResponse;
    expect(body.lives.map((l) => [l.id, l.hasTrace])).toEqual([
      ["life-ada-1", true],
      ["life-ada-2", false],
      ["life-ada-3", true],
    ]);
    expect(body.lives[0]).toMatchObject({
      deathCause: "collision",
      killer: "@bob/snake v1",
      score: 7,
      startedAt: new Date(2000).toISOString(),
      endedAt: new Date(3000).toISOString(),
    });
    const one = (await (await lives(ada, "snake", "?limit=1")).json()) as LivesResponse;
    expect(one.lives).toHaveLength(1);
  });

  it("is only for the bot's owner", async () => {
    // Bob's bot is "snake" too: he sees his own (no lives), never Ada's.
    expect(((await (await lives(bob)).json()) as LivesResponse).lives).toEqual([]);
    const res = await lives(bob, "bot-ada");
    expect(res.status).toBe(403);
    expect(((await res.json()) as ApiErrorBody).error).toBe("not_bot_owner");
  });
});
