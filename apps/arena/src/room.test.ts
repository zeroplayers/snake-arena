import { CHUNK_TICKS, ReplayPlayer, replayChunkInfo } from "@zerosnake/engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHouseBots } from "../scripts/house-bundles.ts";
import { batchTicks } from "./limits.ts";
import type { LifeTicket, RoomStatus } from "./protocol.ts";
import { BOTS, createHarness, type Harness, seedVersion } from "./testing/harness.ts";
import type { MatchmakerEvent } from "./testing/worker.ts";

let h: Harness;
let house: Record<string, string>;

beforeAll(async () => {
  [h, house] = await Promise.all([createHarness(), bundleHouseBots()]);
}, 120_000);

afterAll(async () => {
  await h?.dispose();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ticket(author: string, source: string, lifeId?: string): Promise<LifeTicket> {
  return seedVersion(await h.d1(), author, source, lifeId);
}

async function startRoom(name: string, tickets: LifeTicket[], options: object = {}) {
  await h.room(name, "start", { roomId: name, seed: 7, manual: true, ...options });
  for (const t of tickets) expect(await h.room(name, "join", t)).toEqual({ ok: true });
}

const events = () => h.call<MatchmakerEvent[]>("matchmaker", "events");

async function lifeRow(id: string) {
  const db = await h.d1();
  return db.prepare("SELECT * FROM lives WHERE id = ?").bind(id).first<Record<string, unknown>>();
}

describe("RoomDO", () => {
  it("runs worst-case-sized batches, fills up to 5 authors with house bots", async () => {
    const tickets = await Promise.all([
      ticket("alice", house.hard as string),
      ticket("bob", house.medium as string),
      ticket("carol", house.medium as string),
    ]);
    await startRoom("batches", tickets);
    expect(await h.room("batches", "join", { ...tickets[0], lifeId: "other" })).toEqual({
      ok: false,
      reason: "author-present",
    });
    expect(await h.room("batches", "join", tickets[1])).toEqual({
      ok: false,
      reason: "duplicate-life",
    });

    const s1 = await h.room<RoomStatus>("batches", "runBatch");
    expect(s1.snakes).toHaveLength(5);
    expect(new Set(s1.snakes.map((s) => s.author)).size).toBe(5);
    expect(s1.snakes.filter((s) => s.house).map((s) => s.author)).toEqual([
      "house:easy",
      "house:medium",
    ]);
    // 5 bots, all 5 starting a life.
    expect(s1.lastBatchTicks).toBe(batchTicks(5, 5));
    expect(s1.tick).toBe(batchTicks(5, 5));

    const s2 = await h.room<RoomStatus>("batches", "runBatch");
    expect(s2.lastBatchTicks).toBe(batchTicks(s1.snakes.length, 0));
    expect(s2.tick).toBe(s1.tick + s2.lastBatchTicks);
  }, 60_000);

  it("writes a dead life to D1 and pulls a replacement from the matchmaker", async () => {
    const dave = await ticket("dave", BOTS.thrower);
    const erin = await ticket("erin", house.hard as string);
    const frank = await ticket("frank", house.medium as string);
    await h.call("matchmaker", "offer", frank);
    await startRoom("deaths", [dave, erin]);

    const s1 = await h.room<RoomStatus>("deaths", "runBatch");
    expect(s1.livesEnded).toBeGreaterThanOrEqual(1);
    expect(s1.snakes.map((s) => s.lifeId)).not.toContain(dave.lifeId);
    // Replacement pulled after the batch; it spawns at the start of the next one.
    expect(s1.pending).toContain(frank.lifeId);

    const row = await lifeRow(dave.lifeId);
    expect(row).toMatchObject({
      version_id: dave.versionId,
      room: "deaths",
      start_tick: 0,
      end_tick: 3,
      death_cause: "error",
      replay_key: "deaths/0000000000.zsr",
    });
    const ev = await events();
    expect(ev.find((e) => e.kind === "lifeEnded")?.body).toMatchObject({ lifeId: dave.lifeId });
    const ask = ev.find(
      (e) => e.kind === "nextLife" && (e.body as { roomId: string }).roomId === "deaths",
    );
    expect((ask?.body as { excludeAuthors: string[] } | undefined)?.excludeAuthors).toContain(
      "erin",
    );

    const s2 = await h.room<RoomStatus>("deaths", "runBatch");
    expect(s2.snakes.map((s) => s.lifeId)).toContain(frank.lifeId);
    expect(s2.pending).toEqual([]);
  }, 60_000);

  it("writes ~2-minute replay chunks to R2 and resumes exactly after an eviction", async () => {
    const tickets = await Promise.all(
      ["gina", "hank", "ivan", "judy"].map((a) => ticket(a, house.hard as string)),
    );
    await startRoom("replay", tickets.slice(0, 2));
    for (const t of tickets.slice(2)) await h.call("matchmaker", "offer", t);

    let s = await h.room<RoomStatus>("replay", "runBatch");
    while (s.tick < CHUNK_TICKS / 2) s = await h.room<RoomStatus>("replay", "runBatch");

    // Eviction mid-chunk: memory (bots, open chunk, world) is gone; storage stays.
    await h.restart();
    const after = await h.room<RoomStatus>("replay", "status");
    expect(after.tick).toBe(s.tick);
    expect(after.snakes).toEqual(s.snakes);

    while (s.tick < CHUNK_TICKS * 2 + 50 && s.state === "running") {
      s = await h.room<RoomStatus>("replay", "runBatch");
    }
    expect(s.state).toBe("running");

    const r2 = await h.r2();
    const listed = await r2.list({ prefix: "replay/" });
    const keys = listed.objects.map((o) => o.key).sort();
    expect(keys).toEqual([
      "replay/0000000000.zsr",
      `replay/${String(CHUNK_TICKS).padStart(10, "0")}.zsr`,
    ]);
    const chunks = await Promise.all(
      keys.map(
        async (k) => new Uint8Array(await ((await r2.get(k)) as R2ObjectBody).arrayBuffer()),
      ),
    );
    for (const c of chunks) expect(c.length).toBeLessThan(200_000);
    expect(chunks.map((c) => replayChunkInfo(c).endTick)).toEqual([CHUNK_TICKS, CHUNK_TICKS * 2]);
    // Plays back with hash checks across the restart.
    const player = new ReplayPlayer(chunks);
    player.seek(player.endTick);
    expect(player.world.tick).toBe(CHUNK_TICKS * 2);
  }, 120_000);

  it("bans a version whose code blows the CPU limit (backstop)", async () => {
    const evil = await ticket("mallory", BOTS.hostile(150));
    const others = await Promise.all([
      ticket("kate", house.hard as string),
      ticket("liam", house.medium as string),
    ]);
    await startRoom("backstop", [evil, ...others]);
    const s1 = await h.room<RoomStatus>("backstop", "runBatch");
    expect(s1.tick).toBeLessThan(150);
    expect(s1.snakes.map((s) => s.lifeId)).toContain(evil.lifeId);

    // The next batch reaches the bot's 150th tick and never returns; on Cloudflare the CPU limit
    // kills the object, here a restart does.
    void h.fire("backstop", "runBatch");
    await sleep(1500);
    await h.restart();
    expect((await h.room<RoomStatus>("backstop", "status")).tick).toBe(s1.tick);

    // The next alarm finds the marker and replays the batch one bot at a time: dies again.
    void h.fire("backstop", "runBatch");
    await sleep(4000);
    await h.restart();

    // The alarm after that bans the bot that was running, kills its snake, and carries on.
    const s2 = await h.room<RoomStatus>("backstop", "runBatch");
    expect(s2.bans).toEqual([evil.versionId]);
    expect(s2.incidents).toEqual([{ tick: s1.tick, outcome: "banned", versionId: evil.versionId }]);
    expect(s2.snakes.map((s) => s.lifeId)).not.toContain(evil.lifeId);
    expect(s2.tick).toBeGreaterThan(150);

    expect(await lifeRow(evil.lifeId)).toMatchObject({
      death_cause: "timeout",
      end_tick: s1.tick + 1,
    });
    const db = await h.d1();
    const version = await db
      .prepare("SELECT status, report FROM versions WHERE id = ?")
      .bind(evil.versionId)
      .first<{ status: string; report: string }>();
    expect(version?.status).toBe("rejected");
    expect(JSON.parse(version?.report ?? "{}").ban).toMatchObject({ reason: "cpu", tick: 150 });
    expect((await events()).find((e) => e.kind === "versionBanned")?.body).toMatchObject({
      versionId: evil.versionId,
      lifeId: evil.lifeId,
    });
    expect(
      await h.room("backstop", "join", { ...evil, lifeId: "evil-2", author: "mallory2" }),
    ).toEqual({ ok: false, reason: "banned" });
  }, 120_000);

  it("keeps the replayed result when a dead batch doesn't die again (inconclusive)", async () => {
    // Hostile only with memory built up since its first tick, which a restart wipes.
    const flaky = await ticket("nina", BOTS.hostileWithMemory(150));
    const other = await ticket("oscar", house.hard as string);
    await startRoom("flaky", [flaky, other]);
    const s1 = await h.room<RoomStatus>("flaky", "runBatch");
    void h.fire("flaky", "runBatch");
    await sleep(1500);
    await h.restart();

    const s2 = await h.room<RoomStatus>("flaky", "runBatch");
    expect(s2.incidents).toEqual([{ tick: s1.tick, outcome: "inconclusive", versionId: null }]);
    expect(s2.bans).toEqual([]);
    expect(s2.snakes.map((s) => s.lifeId)).toContain(flaky.lifeId);
    expect(s2.tick).toBeGreaterThan(s1.tick);
  }, 60_000);

  it("runs from alarms: accelerated as fast as it can, real time at 10 ticks/s", async () => {
    const tickets = await Promise.all(["pat", "quinn"].map((a) => ticket(a, house.hard as string)));
    await startRoom("alarms", tickets, { manual: false });
    let s = await h.room<RoomStatus>("alarms", "status");
    for (let i = 0; i < 100 && s.tick < 300; i++) {
      await sleep(100);
      s = await h.room<RoomStatus>("alarms", "status");
    }
    expect(s.tick).toBeGreaterThanOrEqual(300);

    await h.room("alarms", "setMode", "realtime");
    await sleep(1500);
    const from = await h.room<RoomStatus>("alarms", "status");
    await sleep(3000);
    const to = await h.room<RoomStatus>("alarms", "status");
    expect(to.mode).toBe("realtime");
    const rate = (to.tick - from.tick) / 3;
    expect(rate).toBeGreaterThan(5);
    expect(rate).toBeLessThan(15);
  }, 60_000);
});
