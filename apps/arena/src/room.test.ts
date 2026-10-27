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
const status = (name: string) => h.room<RoomStatus>(name, "status");

async function lifeRow(id: string) {
  const db = await h.d1();
  return db.prepare("SELECT * FROM lives WHERE id = ?").bind(id).first<Record<string, unknown>>();
}

/**
 * Runs batches the way alarms would. A batch that doesn't return within `hangMs` is stuck in a
 * bot: workerd is restarted, as Cloudflare's CPU limit would reset the object. Stops when `done`
 * holds. Returns how many times the room was killed.
 */
async function drive(
  name: string,
  done: (s: RoomStatus) => boolean,
  { hangMs = 1500, max = 40 } = {},
): Promise<{ kills: number; s: RoomStatus }> {
  let kills = 0;
  for (let i = 0; i < max; i++) {
    const finished = await Promise.race([
      h.fire(name, "runBatch").then(() => true),
      sleep(hangMs).then(() => false),
    ]);
    if (!finished) {
      kills++;
      await h.restart();
    }
    const s = await status(name);
    if (done(s)) return { kills, s };
  }
  throw new Error(`room ${name}: condition not reached in ${max} batches`);
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
    // 3 tickets + 2 house bots spawned (some may already have died).
    expect(s1.snakes.length + s1.livesEnded).toBe(5);
    expect(new Set(s1.snakes.map((s) => s.author)).size).toBe(s1.snakes.length);
    for (const s of s1.snakes.filter((x) => x.house)) {
      expect(["house:easy", "house:medium"]).toContain(s.author);
    }
    // 5 bots, all 5 starting a life.
    expect(s1.lastBatchTicks).toBe(batchTicks(5, 5));
    expect(s1.tick).toBe(batchTicks(5, 5));

    const s2 = await h.room<RoomStatus>("batches", "runBatch");
    // Between "5 bots, none starting" and "5 bots, all starting" (house bots refill deaths).
    expect(s2.lastBatchTicks).toBeLessThanOrEqual(batchTicks(5, 0));
    expect(s2.lastBatchTicks).toBeGreaterThanOrEqual(batchTicks(5, 5));
    expect(s2.tick).toBe(s1.tick + s2.lastBatchTicks);
    expect(s2.watching).toBe(false);
  }, 60_000);

  it("writes a dead life to D1 once its replay chunk is in R2, and pulls a replacement", async () => {
    const dave = await ticket("dave", BOTS.thrower);
    const erin = await ticket("erin", house.hard as string);
    const frank = await ticket("frank", house.medium as string);
    await h.call("matchmaker", "offer", frank);
    await startRoom("deaths", [dave, erin], { limits: { chunkTicks: 200 } });

    const s1 = await h.room<RoomStatus>("deaths", "runBatch");
    expect(s1.tick).toBeLessThan(200);
    expect(s1.snakes.map((s) => s.lifeId)).not.toContain(dave.lifeId);
    // Replacement pulled after the batch; it spawns at the start of the next one.
    expect(s1.pending).toContain(frank.lifeId);
    const ask = (await events()).find(
      (e) => e.kind === "nextLife" && (e.body as { roomId: string }).roomId === "deaths",
    );
    expect((ask?.body as { excludeAuthors: string[] } | undefined)?.excludeAuthors).toContain(
      "erin",
    );
    // The death's chunk is still being recorded: no row yet.
    expect(await lifeRow(dave.lifeId)).toBeNull();

    const s2 = await h.room<RoomStatus>("deaths", "runBatch");
    expect(s2.snakes.map((s) => s.lifeId)).toContain(frank.lifeId);
    let s = s2;
    while (s.tick <= 200) s = await h.room<RoomStatus>("deaths", "runBatch");

    expect(await lifeRow(dave.lifeId)).toMatchObject({
      version_id: dave.versionId,
      room: "deaths",
      start_tick: 0,
      end_tick: 3,
      death_cause: "error",
      replay_key: "deaths/0000000000.zsr",
    });
    expect(await (await h.r2()).head("deaths/0000000000.zsr")).not.toBeNull();
    expect((await events()).find((e) => e.kind === "lifeEnded")?.body).toMatchObject({
      lifeId: dave.lifeId,
    });
  }, 60_000);

  it("writes ~2-minute replay chunks to R2 and resumes exactly after an eviction", async () => {
    // Plenty of replacements, so real bots outlive the 2400 ticks whatever the house bots do.
    const tickets = await Promise.all(
      ["gina", "hank", "ivan", "judy", "jo", "jim", "jen", "jay", "joy", "jon"].map((a) =>
        ticket(a, house.medium as string),
      ),
    );
    // No house bots: the room's life depends on these alone.
    await startRoom("replay", tickets.slice(0, 2), { minAuthors: 0 });
    for (const t of tickets.slice(2)) await h.call("matchmaker", "offer", t);

    let s = await h.room<RoomStatus>("replay", "runBatch");
    while (s.tick < CHUNK_TICKS / 2) s = await h.room<RoomStatus>("replay", "runBatch");

    // Eviction mid-chunk: memory (bots, open chunk, world) is gone; storage stays.
    await h.restart();
    const after = await status("replay");
    expect(after.tick).toBe(s.tick);
    expect(after.snakes).toEqual(s.snakes);

    while (s.tick < CHUNK_TICKS * 2 + 50 && s.state === "running") {
      s = await h.room<RoomStatus>("replay", "runBatch");
    }
    expect(s.state).toBe("running");
    // An eviction between batches is not an incident.
    expect(s.incidents).toEqual([]);

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

  it("keeps running in real time across an eviction", async () => {
    const tickets = await Promise.all(["kai", "lena"].map((a) => ticket(a, house.hard as string)));
    await startRoom("realtime", tickets, { manual: false, mode: "realtime" });
    await sleep(2000);
    const before = await status("realtime");
    expect(before.tick).toBeGreaterThan(5);
    await h.restart();
    const t0 = performance.now();
    const resumed = await status("realtime");
    expect(resumed.tick).toBeGreaterThanOrEqual(before.tick);
    expect(resumed.snakes.map((s) => s.lifeId)).toEqual(before.snakes.map((s) => s.lifeId));
    await sleep(3000);
    const later = await status("realtime");
    const rate = (later.tick - resumed.tick) / ((performance.now() - t0) / 1000);
    expect(rate).toBeGreaterThan(5);
    expect(rate).toBeLessThan(15);
    expect(later.incidents.every((i) => i.outcome === "restart")).toBe(true);
    // Stop it, so it doesn't run alongside the rest of the suite.
    await h.room("realtime", "leave", tickets[0]?.lifeId);
    await h.room("realtime", "leave", tickets[1]?.lifeId);
  }, 60_000);

  it("runs from alarms: accelerated as fast as it can, real time at 10 ticks/s", async () => {
    const tickets = await Promise.all(["pat", "quinn"].map((a) => ticket(a, house.hard as string)));
    await startRoom("alarms", tickets, { manual: false });
    let s = await status("alarms");
    for (let i = 0; i < 100 && s.tick < 300; i++) {
      await sleep(100);
      s = await status("alarms");
    }
    expect(s.tick).toBeGreaterThanOrEqual(300);

    await h.room("alarms", "setMode", "realtime");
    await sleep(1500);
    const from = await status("alarms");
    await sleep(3000);
    const to = await status("alarms");
    expect(to.mode).toBe("realtime");
    const rate = (to.tick - from.tick) / 3;
    expect(rate).toBeGreaterThan(5);
    expect(rate).toBeLessThan(15);
    await h.room("alarms", "leave", tickets[0]?.lifeId);
    await h.room("alarms", "leave", tickets[1]?.lifeId);
  }, 60_000);

  it("retries failed deliveries with backoff, pauses while they fail, drops nothing", async () => {
    // No `versions` row yet: inserting the life fails its foreign key until we add it.
    const ghost: LifeTicket = {
      lifeId: "life-ghost-1",
      versionId: "v-ghost",
      author: "ghost",
      source: BOTS.thrower,
    };
    const rita = await ticket("rita", house.hard as string);
    await startRoom("outbox", [ghost, rita], { limits: { chunkTicks: 50, maxOutbox: 0 } });

    const s1 = await h.room<RoomStatus>("outbox", "runBatch");
    expect(s1.outbox).toEqual({ size: 1, failing: 1 });
    expect(s1.paused).toBe(true);
    // Not due again yet, and paused: nothing simulated.
    const s2 = await h.room<RoomStatus>("outbox", "runBatch");
    expect(s2.tick).toBe(s1.tick);
    expect(await (await h.r2()).head("outbox/0000000000.zsr")).not.toBeNull();

    await seedVersion(await h.d1(), "ghost", BOTS.thrower);
    await sleep(1100);
    const s3 = await h.room<RoomStatus>("outbox", "runBatch");
    expect(s3.outbox.failing).toBe(0);
    expect(s3.paused).toBe(false);
    expect(s3.tick).toBeGreaterThan(s1.tick);
    expect(await lifeRow(ghost.lifeId)).toMatchObject({ death_cause: "error", end_tick: 3 });
    const ended = (await events()).filter((e) => e.kind === "lifeEnded");
    expect(ended.some((e) => (e.body as LifeTicket).lifeId === ghost.lifeId)).toBe(true);
  }, 60_000);
});

describe("RoomDO backstop", () => {
  // Small CPU limit and batches, so "killed after 1.5 s" counts as CPU-limit evidence.
  const limits = { cpuLimitMs: 1000, batchTicks: 50 };

  it("bans a version whose code, run alone, reproducibly blows the CPU limit", async () => {
    const evil = await ticket("mallory", BOTS.hostile(120));
    const others = await Promise.all([
      ticket("kate", house.hard as string),
      ticket("liam", house.medium as string),
    ]);
    await startRoom("backstop", [evil, ...others], { limits });
    // Its second life, for when the first is killed.
    await h.call("matchmaker", "offer", { ...evil, lifeId: "life-mallory-2" });

    const first = await drive("backstop", (s) => s.strikes.length > 0);
    // Normal batch dies (overrun), watched batch dies in its call (suspect), then its trial dies
    // three times at the same tick (strike); the life is killed.
    expect(first.kills).toBe(5);
    expect(first.s.incidents.map((i) => i.outcome)).toEqual(["overrun", "suspect", "culprit"]);
    expect(first.s.strikes.map((x) => [x.lifeId, x.kind, x.tick])).toEqual([
      [evil.lifeId, "cpu", 120],
    ]);
    expect(first.s.bans).toEqual([]);

    // Its second life does it again: second strike, banned.
    const second = await drive("backstop", (s) => s.bans.length > 0, { max: 60 });
    expect(second.kills).toBe(4);
    expect(second.s.incidents.map((i) => i.outcome)).toEqual([
      "overrun",
      "suspect",
      "culprit",
      "suspect",
      "banned",
    ]);
    expect(second.s.strikes.map((x) => x.lifeId)).toEqual([evil.lifeId, "life-mallory-2"]);
    expect(second.s.bans).toEqual([evil.versionId]);
    expect(second.s.watching).toBe(true);
    // The banned snake dies at the start of the next batch.
    const after = await h.room<RoomStatus>("backstop", "runBatch");
    const alive = after.snakes.map((x) => x.lifeId);
    expect(alive).not.toContain("life-mallory-2");
    expect(alive).toEqual(expect.arrayContaining(others.map((t) => t.lifeId)));

    const db = await h.d1();
    const version = await db
      .prepare("SELECT status, report FROM versions WHERE id = ?")
      .bind(evil.versionId)
      .first<{ status: string; report: string }>();
    expect(version?.status).toBe("rejected");
    expect(JSON.parse(version?.report ?? "{}")).toMatchObject({
      ok: false,
      checks: [{ name: "arena-backstop", ok: false }],
    });
    expect((await events()).find((e) => e.kind === "versionBanned")?.body).toMatchObject({
      versionId: evil.versionId,
      reason: "cpu",
    });
    expect(
      await h.room("backstop", "join", { ...evil, lifeId: "evil-3", author: "mallory2" }),
    ).toEqual({ ok: false, reason: "banned" });
  }, 180_000);

  it("catches a bot that only burns after many ticks of memory (restarts put it off)", async () => {
    // The trial rebuilds its memory from the recorded states since its sandbox life began.
    const burner = await ticket("nina", BOTS.burnAfter(60));
    const other = await ticket("oscar", house.hard as string);
    await startRoom("burner", [burner, other], { limits });
    const { kills, s } = await drive("burner", (s) => s.strikes.length > 0, { max: 80 });
    expect(kills).toBe(5);
    expect(s.incidents.map((i) => i.outcome)).toEqual(["overrun", "suspect", "culprit"]);
    expect(s.strikes.map((x) => x.lifeId)).toEqual([burner.lifeId]);
    // The struck snake dies at the start of the next batch.
    const next = await h.room<RoomStatus>("burner", "runBatch");
    expect(next.snakes.map((x) => x.lifeId)).toContain(other.lifeId);
    expect(next.snakes.map((x) => x.lifeId)).not.toContain(burner.lifeId);
    expect(await lifeRow(burner.lifeId)).toBeNull(); // written once its replay chunk is in R2
  }, 180_000);

  it("never strikes honest bots, however often the room is restarted mid-batch", async () => {
    // The review's repro: five honest versions, restarts at random points, recovery after
    // 1.2 s (longer than this room's CPU limit, so every crash looks like the CPU limit).
    const honest = await Promise.all(
      ["h5", "h6", "h7", "h8", "h9"].map((a) => ticket(a, house.hard as string)),
    );
    await startRoom("storm", honest, { limits });
    await h.room("storm", "runBatch");
    for (let i = 0; i < 20; i++) {
      void h.fire("storm", "runBatch");
      await sleep(20 + ((i * 37) % 120));
      await h.restart();
      await sleep(1200);
    }
    // Let pending trials finish.
    const { s } = await drive("storm", (s) => s.trial === null, { max: 40 });
    expect(s.strikes).toEqual([]);
    expect(s.bans).toEqual([]);
    expect(s.incidents.some((i) => i.outcome === "culprit" || i.outcome === "slow")).toBe(false);
    expect(s.snakes.filter((x) => !x.house).map((x) => x.lifeId)).toEqual(
      expect.arrayContaining(honest.map((t) => t.lifeId)),
    );
  }, 180_000);

  it("blames nobody when the room is restarted twice in a row (no CPU-limit evidence)", async () => {
    // Default 30 s CPU limit; a slow but honest bot just makes the batch long enough to interrupt.
    const slowpoke = await ticket("pia", BOTS.slow(100));
    const tom = await ticket("tom", house.hard as string);
    await startRoom("restarts", [slowpoke, tom], { limits: { batchTicks: 50 } });
    for (let i = 0; i < 2; i++) {
      void h.fire("restarts", "runBatch");
      await sleep(800);
      await h.restart();
    }
    const s = await h.room<RoomStatus>("restarts", "runBatch");
    expect(s.incidents.map((i) => i.outcome)).toEqual(["restart", "restart"]);
    expect(s.strikes).toEqual([]);
    expect(s.bans).toEqual([]);
    expect(s.watching).toBe(false);
    expect(s.tick).toBe(50);
    expect(s.snakes.map((x) => x.lifeId)).toEqual(
      expect.arrayContaining([slowpoke.lifeId, tom.lifeId]),
    );
  }, 60_000);

  it("kills a bot slow every tick once a trial confirms it, bans it on its second life", async () => {
    const slow = await ticket("quentin", BOTS.slow(300));
    const honest = await Promise.all([
      ticket("ruth", house.hard as string),
      ticket("sam", house.medium as string),
    ]);
    await startRoom("slow", [slow, ...honest], {
      limits: { cpuLimitMs: 2000, batchTicks: 50, slowTickMs: 100 },
    });
    await h.call("matchmaker", "offer", { ...slow, lifeId: "life-quentin-2" });

    // The normal batch overruns in aggregate (~12 s); watch mode measures it slow; its trial
    // (alone, no crash) confirms.
    const first = await drive("slow", (s) => s.strikes.length > 0, { hangMs: 2500 });
    expect(first.kills).toBe(1);
    expect(first.s.incidents.map((i) => i.outcome)).toEqual(["overrun", "suspect", "slow"]);

    const second = await drive("slow", (s) => s.bans.length > 0, { hangMs: 2500 });
    expect(second.kills).toBe(0);
    expect(second.s.strikes.map((x) => [x.lifeId, x.kind])).toEqual([
      [slow.lifeId, "slow"],
      ["life-quentin-2", "slow"],
    ]);
    expect(second.s.bans).toEqual([slow.versionId]);
    expect(second.s.snakes.map((x) => x.lifeId)).toEqual(
      expect.arrayContaining(honest.map((t) => t.lifeId)),
    );
  }, 120_000);
});
