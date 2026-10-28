import { CHUNK_TICKS, ReplayPlayer, replayChunkInfo } from "@zerosnake/engine";
import { describe, expect, it } from "vitest";
import { batchTicks } from "./limits.ts";
import type { LifeDrop, LifeTicket, RoomStatus } from "./protocol.ts";
import { BOTS } from "./testing/harness.ts";
import {
  events,
  h,
  house,
  lifeRow,
  sleep,
  spares,
  startRoom,
  status,
  ticket,
  useRoomHarness,
} from "./testing/room-tests.ts";

// The CPU backstop's tests are in `room.backstop*.test.ts`.
useRoomHarness();

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
    // No `METRICS` binding in this harness: nothing is written, and the room doesn't mind.
    expect(await h.room("deaths", "metricPoints")).toEqual([]);
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
    // No `lives` table for a while: inserting the life fails until it's back. (A missing
    // `versions` row wouldn't do: a life of a deleted version is dropped, not retried.)
    const ghost = await ticket("ghost", BOTS.thrower);
    const rita = await ticket("rita", house.hard as string);
    await startRoom("outbox", [ghost, rita], { limits: { chunkTicks: 50, maxOutbox: 0 } });
    const db = await h.d1();
    await db.prepare("ALTER TABLE lives RENAME TO lives_away").run();

    const s1 = await h.room<RoomStatus>("outbox", "runBatch");
    expect(s1.outbox).toEqual({ size: 1, failing: 1 });
    expect(s1.paused).toBe(true);
    // Not due again yet, and paused: nothing simulated.
    const s2 = await h.room<RoomStatus>("outbox", "runBatch");
    expect(s2.tick).toBe(s1.tick);
    expect(await (await h.r2()).head("outbox/0000000000.zsr")).not.toBeNull();

    await db.prepare("ALTER TABLE lives_away RENAME TO lives").run();
    await sleep(1100);
    const s3 = await h.room<RoomStatus>("outbox", "runBatch");
    expect(s3.outbox.failing).toBe(0);
    expect(s3.paused).toBe(false);
    expect(s3.tick).toBeGreaterThan(s1.tick);
    expect(await lifeRow(ghost.lifeId)).toMatchObject({ death_cause: "error", end_tick: 3 });
    const ended = (await events()).filter((e) => e.kind === "lifeEnded");
    expect(ended.some((e) => (e.body as LifeTicket).lifeId === ghost.lifeId)).toBe(true);
  }, 60_000);

  it("retires its lives and closes when an admin stops the arena", async () => {
    const tickets = await Promise.all(
      ["stop1", "stop2"].map((a) => ticket(a, house.hard as string)),
    );
    await startRoom("stopped", tickets, { limits: { arenaControlPollMs: 0, chunkTicks: 50 } });
    await spares("stopped", 2);
    const before = await h.room<RoomStatus>("stopped", "runBatch");
    expect(before.snakes.some((x) => x.versionId !== null)).toBe(true);
    const db = await h.d1();
    const setPaused = (paused: number) =>
      db.prepare("UPDATE arena_control SET paused = ? WHERE id = 1").bind(paused).run();
    await setPaused(1);
    try {
      const s = await h.room<RoomStatus>("stopped", "runBatch");
      expect(s.arenaPaused).toBe(true);
      expect(s.state).toBe("closed");
      expect(s.pending).toEqual([]);
      expect(await h.room("stopped", "join", await ticket("late", BOTS.circler))).toEqual({
        ok: false,
        reason: "closed",
      });
      // Real lives that were running end `retired`, nobody's fault.
      for (const t of tickets.filter((t) => before.snakes.some((x) => x.lifeId === t.lifeId))) {
        expect(await lifeRow(t.lifeId)).toMatchObject({ death_cause: "retired" });
      }
    } finally {
      await setPaused(0);
    }
  }, 60_000);

  it("closes a room saved by the round-arena engine, dropping its lives unrated", async () => {
    const tickets = await Promise.all(
      ["old1", "old2"].map((a) => ticket(a, house.medium as string)),
    );
    await startRoom("pre-square", tickets);
    await spares("pre-square", 1);
    const before = await h.room<RoomStatus>("pre-square", "runBatch");
    const running = tickets.filter((t) => before.snakes.some((x) => x.lifeId === t.lifeId));
    expect(running.length).toBeGreaterThan(0);
    // The engine is deployed under the running room: its storage is from the old one.
    await h.restart();
    await h.room("pre-square", "makePreSquare");

    const s = await h.room<RoomStatus>("pre-square", "runBatch");
    expect(s.state).toBe("closed");
    expect(s.snakes).toEqual([]);
    expect(s.pending).toEqual([]);
    expect(s.incidents).toEqual([]);
    expect(s.evictions).toEqual([]);
    expect(s.quarantined).toEqual([]);
    const seen = await events();
    const dropped = seen.filter((e) => e.kind === "lifeDropped").map((e) => e.body as LifeDrop);
    for (const t of tickets) {
      expect(dropped).toContainEqual(
        expect.objectContaining({ lifeId: t.lifeId, reason: "outdated" }),
      );
      expect(await lifeRow(t.lifeId)).toBeNull();
    }
    expect(seen.some((e) => e.kind === "roomClosed" && e.body === "pre-square")).toBe(true);
    // Nothing left that would make the next alarm fail.
    expect((await h.room<RoomStatus>("pre-square", "runBatch")).state).toBe("closed");
  }, 60_000);
});
