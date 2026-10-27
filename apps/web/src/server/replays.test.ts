/**
 * Replay retention (#78): which lives are pinned (and stay pinned), which chunks a pinned life
 * needs, the sweep (budget, idempotence, a pinned set that can't be read or shrank deletes
 * nothing) and the 410 of `GET /api/lives/:id/replay` once a replay is gone.
 */
import { Buffer } from "node:buffer";
import { createWorld, ReplayRecorder } from "@zerosnake/engine";
import { MAX_LIFE_SCORE } from "@zerosnake/rating";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../db";
import { recentLives } from "../queries/bot";
import { getReplayLife } from "../queries/replay";
import {
  REPLAY_EXPIRED_MESSAGE,
  REPLAY_PINNED_LIVES_PER_BOT,
  REPLAY_PINNED_TOP_BOTS,
  REPLAY_PINNED_TOP_LIVES,
  REPLAY_RETENTION_DAYS,
  type ReplayResponse,
} from "../shared/replay";
import { createTestPlatform, type TestPlatformEnv } from "../test/d1";
import { replayResponse } from "./replay-api";
import {
  bestLivesQuery,
  botBestLivesQuery,
  isPinned,
  loadPinnedLives,
  PinnedSetError,
  parseChunkKey,
  pinsOf,
  runReplaySweep,
  selectPinnedLives,
  sweepReplays,
} from "./replays";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const key = (room: string, tick: number) => `${room}/${String(tick).padStart(10, "0")}.zsr`;

// The fixtures write a few hundred rows and R2 objects through workerd.
vi.setConfig({ hookTimeout: 30_000 });

let platform: Awaited<ReturnType<typeof createTestPlatform>>;
let env: TestPlatformEnv;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  platform = await createTestPlatform();
  env = platform.env;
}, 30_000);

afterAll(() => platform.dispose());

async function run(...statements: string[]) {
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
}

async function reset() {
  await run("DELETE FROM lives", "DELETE FROM ratings", "DELETE FROM versions", "DELETE FROM bots");
  await run("DELETE FROM users");
  let listed = await env.REPLAYS.list();
  while (listed.objects.length > 0) {
    await env.REPLAYS.delete(listed.objects.map((o) => o.key));
    listed = await env.REPLAYS.list();
  }
  await run(
    `INSERT INTO users (id, name, email, email_verified, username)
     VALUES ('u', 'U', 'u@test.invalid', 1, 'u')`,
  );
}

/** A bot with one version, `ready` unless said otherwise. */
function botSql(bot: string, version: string, status = "ready", n = 1, owner = "u") {
  return [
    `INSERT INTO bots (id, owner_id, name, slug) VALUES ('${bot}', '${owner}', '${bot}', '${bot}')
     ON CONFLICT DO NOTHING`,
    `INSERT INTO versions (id, bot_id, n, status, bundle_key, source_key)
     VALUES ('${version}', '${bot}', ${n}, '${status}', 'b', 's')`,
  ];
}

const addBot = (...args: Parameters<typeof botSql>) => run(...botSql(...args));

function lifeSql(
  id: string,
  version: string,
  {
    room = "r",
    start = 0,
    score = 0,
    replayKey = null as string | null,
    expired = false,
    ended = 1,
  } = {},
) {
  return `INSERT INTO lives (id, version_id, room, start_tick, end_tick, score, replay_key,
            started_at, ended_at, replay_expired_at)
          VALUES ('${id}', '${version}', '${room}', ${start}, ${start + 10}, ${score},
            ${replayKey === null ? "NULL" : `'${replayKey}'`}, 0, ${ended}, ${expired ? 1 : "NULL"})`;
}

const keys = async () => (await env.REPLAYS.list()).objects.map((o) => o.key).sort();
const expired = async () => {
  const { results } = await env.DB.prepare(
    "SELECT id FROM lives WHERE replay_expired_at IS NOT NULL ORDER BY id",
  ).all<{ id: string }>();
  return results.map((r) => r.id);
};

describe("chunk mapping", () => {
  it("parses the room's chunk keys", () => {
    expect(parseChunkKey("3f2a-uuid/0000002400.zsr")).toEqual({ room: "3f2a-uuid/", tick: 2400 });
    expect(parseChunkKey("seed/replays/room/0.bin")).toBeNull();
    expect(parseChunkKey("0000002400.zsr")).toBeNull();
  });

  // A life born at tick 150 that died in the chunk starting at 200: chunks start every 100.
  const pins = pinsOf([{ id: "l", startTick: 150, endTick: 250, replayKey: key("a", 200) }]);

  it("keeps every chunk from the life's birth to its death", () => {
    expect(isPinned(pins, key("a", 0), 100)).toBe(false);
    expect(isPinned(pins, key("a", 100), 200)).toBe(true);
    expect(isPinned(pins, key("a", 200), 300)).toBe(true);
    expect(isPinned(pins, key("a", 300), 400)).toBe(false);
    expect(isPinned(pins, key("b", 100), 200)).toBe(false);
  });

  it("keeps a chunk whose end is unknown if the life might start in it", () => {
    expect(isPinned(pins, key("a", 0), undefined)).toBe(true);
    expect(isPinned(pins, key("a", 300), undefined)).toBe(false);
  });

  it("keeps the chunk before a life born on a chunk boundary", () => {
    const edge = pinsOf([{ id: "l", startTick: 300, endTick: 450, replayKey: key("a", 400) }]);
    expect(isPinned(edge, key("a", 200), 300)).toBe(true);
    expect(isPinned(edge, key("a", 100), 200)).toBe(false);
  });

  it("keeps a pinned key that isn't a chunk key, and nothing else like it", () => {
    const odd = pinsOf([{ id: "l", startTick: 0, endTick: 1, replayKey: "seed/x/0.bin" }]);
    expect(isPinned(odd, "seed/x/0.bin", undefined)).toBe(true);
    expect(isPinned(odd, "seed/x/1.bin", undefined)).toBe(false);
  });
});

describe("pinned lives", () => {
  // A day after the chunks below are put, so they can be past the retention while pins aren't.
  const T0 = Date.now() + DAY_MS;

  beforeAll(async () => {
    await reset();
    // 21 ranked bots, `b01` first; each has 7 lives scoring 10..16, all below the filler's.
    const ranked = Array.from({ length: REPLAY_PINNED_TOP_BOTS + 1 }, (_, k) => {
      const n = String(k + 1).padStart(2, "0");
      return [
        ...botSql(`b${n}`, `v${n}`),
        ...Array.from({ length: 7 }, (_, j) =>
          lifeSql(`v${n}-${j}`, `v${n}`, { score: 10 + j, replayKey: key(`room-${n}`, j) }),
        ),
        `INSERT INTO ratings (version_id, activated_at, mean, ci, n_lives)
         VALUES ('v${n}', (SELECT activated_at FROM versions WHERE id = 'v${n}'), ${99 - k}, 0, 30)`,
      ];
    });
    await run(
      `INSERT INTO users (id, name, email, email_verified, username, banned_at)
       VALUES ('banned', 'B', 'b@test.invalid', 1, 'banned', 1)`,
      ...ranked.flat(),
      // `b01`'s older version: its best life counts for the bot.
      ...botSql("b01", "v01-old", "archived", 2),
      lifeSql("v01-old-best", "v01-old", { score: 500, replayKey: key("room-01", 99) }),
      // An unranked bot with 120 lives scoring 1000..1119, the best of all time.
      ...botSql("filler", "vf"),
      `INSERT INTO lives (id, version_id, room, start_tick, end_tick, score, replay_key, started_at,
         ended_at)
       WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i < 119)
       SELECT 'vf-' || i, 'vf', 'room-f', 0, 10, 1000 + i, 'room-f/' || i || '.zsr', 0, 1 FROM seq`,
      // Better still, but their replays are gone or were never recorded.
      lifeSql("vf-expired", "vf", { score: 9000, replayKey: key("room-f", 1), expired: true }),
      lifeSql("vf-unrecorded", "vf", { score: 9001 }),
      // A score the rating job rejects, a banned author's and a banned bot's: never pinned.
      lifeSql("vf-absurd", "vf", { score: MAX_LIFE_SCORE + 1, replayKey: key("room-f", 2) }),
      ...botSql("evil", "v-evil", "archived", 1, "banned"),
      lifeSql("evil-best", "v-evil", { score: 9002, replayKey: key("room-e", 0) }),
      ...botSql("banned-bot", "v-bb", "archived"),
      "UPDATE bots SET banned_at = 1 WHERE id = 'banned-bot'",
      lifeSql("bb-best", "v-bb", { score: 9003, replayKey: key("room-e", 1) }),
      // Ties the 100th best (`vf-20`, ended at 1) but ended later: the incumbent keeps its slot.
      lifeSql("vf-tie", "vf", { score: 1020, replayKey: key("room-f", 3), ended: 5 }),
    );
  });

  it("pins the best lives of all time and of each top leaderboard bot", async () => {
    const pinned = await selectPinnedLives(createDb(env.DB));
    const ids = new Set(pinned.map((p) => p.id));
    expect(pinned).toHaveLength(
      REPLAY_PINNED_TOP_LIVES + REPLAY_PINNED_TOP_BOTS * REPLAY_PINNED_LIVES_PER_BOT,
    );

    const filler = [...ids].filter((id) => id.startsWith("vf-"));
    expect(filler).toHaveLength(REPLAY_PINNED_TOP_LIVES);
    expect(ids.has("vf-119")).toBe(true);
    expect(ids.has("vf-20")).toBe(true);
    expect(ids.has("vf-tie")).toBe(false);
    expect(ids.has("vf-19")).toBe(false);
    for (const id of ["vf-expired", "vf-unrecorded", "vf-absurd", "evil-best", "bb-best"]) {
      expect(ids.has(id), id).toBe(false);
    }

    // b02..b20: their 5 best; b01: its old version's best and 4 of the current one's.
    expect([...ids].filter((id) => id.startsWith("v02-")).sort()).toEqual(
      ["v02-2", "v02-3", "v02-4", "v02-5", "v02-6"].sort(),
    );
    expect([...ids].filter((id) => id.startsWith("v01")).sort()).toEqual(
      ["v01-3", "v01-4", "v01-5", "v01-6", "v01-old-best"].sort(),
    );
    expect(ids.has("v20-6")).toBe(true);
    // The 21st bot is off the pinned part of the leaderboard.
    expect([...ids].some((id) => id.startsWith("v21-"))).toBe(false);
    expect(pinned.find((p) => p.id === "v02-6")).toEqual({
      id: "v02-6",
      startTick: 0,
      endTick: 10,
      replayKey: key("room-02", 6),
    });
  });

  it("reads lives in index order, through the partial indexes", async () => {
    const db = createDb(env.DB);
    const plan = async (query: { toSQL(): { sql: string; params: unknown[] } }) => {
      const { sql, params } = query.toSQL();
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...params)
        .all<{ id: number; parent: number; detail: string }>();
      return results;
    };
    // All time: walks `lives_replay_score_idx` by score. Only equal scores get sorted (by end
    // time, "LAST 2 TERMS"), as they come, so `LIMIT` still stops the walk early.
    const best = await plan(bestLivesQuery(db));
    expect(best.map((r) => r.detail).join("\n")).toMatch(/lives_replay_score_idx/);
    expect(best.some((r) => r.detail === "USE TEMP B-TREE FOR ORDER BY")).toBe(false);

    // Per bot: each version's best few come from `lives_version_replay_score_idx` in score order
    // (no full sort inside the subquery); only those few rows are sorted for the bot.
    const ofBot = await plan(botBestLivesQuery(db, "b01"));
    const subquery = ofBot.find((r) => /LIST SUBQUERY/.test(r.detail));
    expect(subquery).toBeDefined();
    const inside = ofBot.filter((r) => r.parent === subquery?.id).map((r) => r.detail);
    expect(inside.join("\n")).toMatch(/lives_version_replay_score_idx \(version_id=\?\)/);
    expect(inside).not.toContain("USE TEMP B-TREE FOR ORDER BY");

    const { results } = await env.DB.prepare(
      `EXPLAIN QUERY PLAN UPDATE lives SET replay_expired_at = 1
       WHERE replay_expired_at IS NULL AND replay_key IN (?, ?)`,
    )
      .bind("a", "b")
      .all<{ detail: string }>();
    expect(results.map((r) => r.detail).join("\n")).toMatch(/lives_replay_key_idx/);
  });

  it("keeps a bot's best lives pinned for the retention after it leaves the top 20", async () => {
    const db = createDb(env.DB);
    const all = REPLAY_PINNED_TOP_LIVES + REPLAY_PINNED_TOP_BOTS * REPLAY_PINNED_LIVES_PER_BOT;
    expect(await loadPinnedLives(db, T0)).toHaveLength(all);

    // b02 redeploys: its new version has no rating yet, so it's off the leaderboard (and b21 on).
    await run(
      "UPDATE versions SET status = 'archived' WHERE id = 'v02'",
      ...botSql("b02", "v02-new", "ready", 3),
    );
    const fresh = new Set((await selectPinnedLives(db)).map((p) => p.id));
    expect(fresh.has("v02-6")).toBe(false);
    expect(fresh.has("v21-6")).toBe(true);

    const later = new Set((await loadPinnedLives(db, T0 + HOUR_MS)).map((p) => p.id));
    expect(later.size).toBe(all + REPLAY_PINNED_LIVES_PER_BOT);
    for (const j of [2, 3, 4, 5, 6]) expect(later.has(`v02-${j}`)).toBe(true);

    // A sweep meanwhile keeps their chunks: `v02-6` died in room-02's chunk at 6.
    await env.REPLAYS.put(key("room-02", 6), "chunk");
    await env.REPLAYS.put(key("room-x", 0), "chunk");
    const sweep = await sweepReplays(env, T0 + 1.5 * DAY_MS, { random: () => 0 });
    expect(sweep).toMatchObject({ deleted: 1, pinnedChunks: 1 });
    expect(await keys()).toEqual([key("room-02", 6)]);

    // Two days after the last run that picked them, they're no longer pinned.
    const gone = new Set(
      (await loadPinnedLives(db, T0 + REPLAY_RETENTION_DAYS * DAY_MS + HOUR_MS)).map((p) => p.id),
    );
    expect(gone.has("v02-6")).toBe(false);
    expect(gone.has("v21-6")).toBe(true);
  });

  it("deletes nothing when the pinned set shrinks to less than half of the last run's", async () => {
    const db = createDb(env.DB);
    const now = T0 + 3 * DAY_MS;
    const before = await loadPinnedLives(db, now);
    expect(before.length).toBeGreaterThan(100);
    await env.REPLAYS.put(key("room-f", 1000), "old");
    const objects = await keys();

    // Banning the only author empties both the all-time list and the leaderboard.
    await run("UPDATE users SET banned_at = 1 WHERE id = 'u'");
    await expect(loadPinnedLives(db, now + HOUR_MS)).rejects.toBeInstanceOf(PinnedSetError);
    await expect(
      sweepReplays(env, now + HOUR_MS + REPLAY_RETENTION_DAYS * DAY_MS),
    ).rejects.toBeInstanceOf(PinnedSetError);
    expect(await keys()).toEqual(objects);
    const { results } = await env.DB.prepare(
      "SELECT count(*) AS n FROM lives WHERE replay_pinned_at > ?",
    )
      .bind(now)
      .all<{ n: number }>();
    expect(results[0]?.n).toBe(0);
    await run("UPDATE users SET banned_at = NULL WHERE id = 'u'");
  });
});

describe("sweepReplays", () => {
  let now: number;

  beforeEach(async () => {
    await reset();
    await addBot("bot", "v");
    await run(
      // Pinned (best of all time): born at 150, died in room-a's chunk at 200.
      lifeSql("pinned", "v", {
        room: "room-a",
        start: 150,
        score: 5000,
        replayKey: key("room-a", 200),
      }),
      lifeSql("dropped", "v", {
        room: "room-a",
        start: 290,
        score: 1,
        replayKey: key("room-a", 300),
      }),
      lifeSql("fresh", "v", {
        room: "room-a",
        start: 520,
        score: 1,
        replayKey: key("room-a", 500),
      }),
      lifeSql("room-b", "v", {
        room: "room-b",
        start: 120,
        score: 1,
        replayKey: key("room-b", 100),
      }),
      // 99 better lives whose chunks aren't in the bucket: the three above aren't pinned.
      `INSERT INTO lives (id, version_id, room, start_tick, end_tick, score, replay_key, started_at,
         ended_at)
       WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i < 98)
       SELECT 'top-' || i, 'v', 'room-t', 0, 10, 1000 + i, 'room-t/' || i || '.zsr', 0, 1 FROM seq`,
    );
    const put = (keys: string[]) => Promise.all(keys.map((k) => env.REPLAYS.put(k, "chunk")));
    await put([0, 100, 200, 300, 400].map((t) => key("room-a", t)));
    await put([key("room-b", 0), key("room-b", 100)]);
    const old = await env.REPLAYS.list();
    const oldest = Math.max(...old.objects.map((o) => o.uploaded.getTime()));
    while (Date.now() <= oldest + 2) await new Promise((r) => setTimeout(r, 2));
    await put([key("room-a", 500), key("room-a", 600), key("room-c", 0)]);
    const all = await env.REPLAYS.list();
    const youngest = Math.min(
      ...all.objects.filter((o) => o.uploaded.getTime() > oldest).map((o) => o.uploaded.getTime()),
    );
    // Chunks put before `youngest` are older than the retention, the rest aren't.
    now = youngest + REPLAY_RETENTION_DAYS * DAY_MS;
  });

  const KEPT = [
    key("room-a", 100),
    key("room-a", 200),
    key("room-a", 500),
    key("room-a", 600),
    key("room-c", 0),
  ].sort();

  it("deletes old chunks no pinned life needs and marks the lives that died in them", async () => {
    const sweep = await sweepReplays(env, now, { random: () => 0 });
    expect(sweep).toMatchObject({
      outcome: "done",
      deleted: 5,
      pinnedChunks: 2,
      pinnedLives: 100,
      expiredLives: 2,
      rooms: 3,
      roomsSwept: 3,
    });
    expect(sweep.oldestDeletedHours).toBeGreaterThanOrEqual(REPLAY_RETENTION_DAYS * 24);
    expect(await keys()).toEqual(KEPT);
    expect(await expired()).toEqual(["dropped", "room-b"]);

    const db = createDb(env.DB);
    expect(await getReplayLife(db, "dropped")).toMatchObject({
      replayRecorded: true,
      replayExpired: true,
    });
    expect(await getReplayLife(db, "fresh")).toMatchObject({
      replayRecorded: true,
      replayExpired: false,
    });
    const listed = await recentLives(db, "v", 200);
    expect(listed.find((l) => l.id === "dropped")).toMatchObject({
      hasReplay: false,
      replayExpired: true,
    });
    expect(listed.find((l) => l.id === "fresh")).toMatchObject({
      hasReplay: true,
      replayExpired: false,
    });

    // Nothing left to do.
    expect(await sweepReplays(env, now)).toMatchObject({
      outcome: "done",
      deleted: 0,
      oldestDeletedHours: 0,
    });
    expect(await keys()).toEqual(KEPT);
  });

  it("stops at its budget and carries on in the next run", async () => {
    const first = await sweepReplays(env, now, { random: () => 0, deletes: 2 });
    expect(first).toMatchObject({ outcome: "more", deleted: 2, expiredLives: 1 });
    expect(await keys()).not.toContain(key("room-a", 0));
    expect(await keys()).not.toContain(key("room-a", 300));

    const second = await sweepReplays(env, now, { random: () => 0, lists: 2 });
    // One list call for the rooms, one for room-a: room-b waits.
    expect(second).toMatchObject({ outcome: "more", deleted: 1, lists: 2, roomsSwept: 1 });

    const out = await sweepReplays(env, now, { random: () => 0, timeMs: 0 });
    // Out of time before the first room: it lists the rooms and stops.
    expect(out).toMatchObject({ outcome: "more", deleted: 0, roomsSwept: 0 });

    expect(await sweepReplays(env, now)).toMatchObject({ outcome: "done", deleted: 2 });
    expect(await keys()).toEqual(KEPT);
    expect(await expired()).toEqual(["dropped", "room-b"]);
  });

  it("deletes nothing when the pinned lives can't be read", async () => {
    const before = await keys();
    const broken = {
      prepare: () => {
        throw new Error("D1 is down");
      },
      batch: () => Promise.reject(new Error("D1 is down")),
    } as unknown as D1Database;
    await expect(sweepReplays({ DB: broken, REPLAYS: env.REPLAYS }, now)).rejects.toBeInstanceOf(
      PinnedSetError,
    );
    expect(await keys()).toEqual(before);

    const errors = vi.mocked(console.error);
    errors.mockClear();
    expect(await runReplaySweep({ DB: broken, REPLAYS: env.REPLAYS }, new Date(now))).toBeNull();
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({ event: "replays.sweep_failed", outcome: "no_pins" }),
    );
    expect(await keys()).toEqual(before);
    expect(await expired()).toEqual([]);
  });

  it("only takes a chunk's end from the same room, not from a nested key", async () => {
    // Born at 120 in room-n, died in a chunk that's gone; room-n's last chunk is at 100, followed
    // in the listing by a key of a nested prefix starting at "tick" 50.
    await run(
      lifeSql("nested", "v", {
        room: "room-n",
        start: 120,
        score: 6000,
        replayKey: key("room-n", 150),
      }),
    );
    await env.REPLAYS.put(key("room-n", 100), "chunk");
    await env.REPLAYS.put(key("room-n/x", 50), "chunk");
    const sweep = await sweepReplays(env, now + DAY_MS, { random: () => 0 });
    expect(sweep.outcome).toBe("done");
    expect(await keys()).toContain(key("room-n", 100));
    expect(await keys()).not.toContain(key("room-n/x", 50));
  });

  it("logs and writes a metric for each run", async () => {
    const points: unknown[] = [];
    const sweep = await runReplaySweep(
      { ...env, METRICS: { writeDataPoint: (p) => points.push(p) } },
      new Date(now),
    );
    expect(sweep?.deleted).toBe(5);
    expect(points).toEqual([
      expect.objectContaining({
        indexes: ["replays.swept"],
        blobs: ["replays.swept", "web", "done"],
      }),
    ]);
  });

  it("reports what a failed run deleted before it failed", async () => {
    let deletes = 0;
    const flaky = {
      list: (options?: R2ListOptions) => env.REPLAYS.list(options),
      delete: async (keys: string[]) => {
        if (++deletes > 1) throw new Error("R2 is down");
        await env.REPLAYS.delete(keys);
      },
    } as unknown as R2Bucket;
    const points: { doubles?: number[]; blobs?: (string | null)[] }[] = [];
    const sweep = await runReplaySweep(
      { DB: env.DB, REPLAYS: flaky, METRICS: { writeDataPoint: (p) => points.push(p ?? {}) } },
      new Date(now),
      { random: () => 0, flushKeys: 2 },
    );
    expect(sweep).toBeNull();
    // `double1` counts events; `deleted` is the first field after it.
    expect(points[0]?.blobs?.[2]).toBe("failed");
    expect(points[0]?.doubles?.[1]).toBe(2);
    expect(vi.mocked(console.error)).toHaveBeenCalledWith(
      expect.objectContaining({ event: "replays.sweep_failed", outcome: "failed", deleted: 2 }),
    );
  });

  it("alerts when the oldest chunk it deletes is far past the retention", async () => {
    const errors = vi.mocked(console.error);
    errors.mockClear();
    await runReplaySweep(env, new Date(now + DAY_MS));
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({ event: "replays.swept", alert: "replay_backlog" }),
    );
  });
});

describe("GET /api/lives/:id/replay", () => {
  let chunk: Uint8Array;

  beforeAll(async () => {
    await reset();
    await addBot("bot", "v");
    const recorder = new ReplayRecorder(createWorld({ seed: 1 }), { onChunk: () => {} });
    recorder.spawn({ id: "ok", author: "u" });
    for (let i = 0; i < 5; i++) recorder.step();
    chunk = recorder.flush() as Uint8Array;
    await env.REPLAYS.put(key("room", 0), chunk);
    await env.REPLAYS.put(key("room", 5), chunk);
    await run(
      lifeSql("ok", "v", { room: "room", replayKey: key("room", 0) }),
      lifeSql("marked", "v", { room: "room", replayKey: key("room", 5), expired: true }),
      lifeSql("lost", "v", { room: "room", replayKey: key("room", 10) }),
      lifeSql("unrecorded", "v", { room: "room" }),
    );
  });

  const get = async (id: string) => {
    const response = await replayResponse(createDb(env.DB), env.REPLAYS, id);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  it("serves the chunk the life died in", async () => {
    const { status, body } = await get("ok");
    expect(status).toBe(200);
    const replay = body as unknown as ReplayResponse;
    expect(Buffer.from(replay.chunk, "base64")).toEqual(Buffer.from(chunk));
    expect(replay.participants.map((p) => p.id).sort()).toEqual([
      "lost",
      "marked",
      "ok",
      "unrecorded",
    ]);
  });

  it("answers 410 for an expired replay, marked or just gone from R2, and marks the latter", async () => {
    const db = createDb(env.DB);
    expect(await getReplayLife(db, "lost")).toMatchObject({ replayExpired: false });
    for (const id of ["marked", "lost"]) {
      expect(await get(id)).toEqual({
        status: 410,
        body: { error: "replay_expired", message: REPLAY_EXPIRED_MESSAGE },
      });
    }
    // No longer linked, and no longer holding a pinned slot.
    expect(await getReplayLife(db, "lost")).toMatchObject({ replayExpired: true });
  });

  it("answers 404 for a life without a replay, or no life", async () => {
    expect(await get("unrecorded")).toMatchObject({
      status: 404,
      body: { error: "replay_not_found" },
    });
    expect(await get("nope")).toMatchObject({ status: 404, body: { error: "life_not_found" } });
  });
});
