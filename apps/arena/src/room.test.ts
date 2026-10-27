import { CHUNK_TICKS, ReplayPlayer, replayChunkInfo } from "@zerosnake/engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHouseBots } from "../scripts/house-bundles.ts";
import { batchTicks } from "./limits.ts";
import type { LifeResult, LifeTicket, QuarantineRecord, RoomStatus } from "./protocol.ts";
import {
  KILLS_TO_EVICT,
  ROOM_KILLS_TO_EVICT,
  VERSION_KILLS_TO_QUARANTINE,
} from "./room/backstop.ts";
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

// The backstop tests' burning bots circle in place until they burn; on some seeds another snake
// runs across them first (seed 7 did on the square arena, #76), and the life the test expects to
// burn is gone.
const ROOM_SEED = 8;

async function startRoom(name: string, tickets: LifeTicket[], options: object = {}) {
  await h.room(name, "start", { roomId: name, seed: ROOM_SEED, manual: true, ...options });
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
 *
 * `hangMs` stands in for the CPU limit, but in wall time, so it is set well above the rooms'
 * `cpuLimitMs`: a watched batch spends wall time waiting (syncs, random gaps) that uses no CPU.
 */
async function drive(
  name: string,
  done: (s: RoomStatus) => boolean,
  { hangMs = 4000, max = 40 } = {},
): Promise<{ kills: number; s: RoomStatus }> {
  let kills = 0;
  let last: RoomStatus | null = null;
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
    last = s;
    if (done(s)) return { kills, s };
  }
  const { tick, incidents, evictions, kills: window, snakes } = last ?? ({} as RoomStatus);
  throw new Error(
    `room ${name}: condition not reached in ${max} batches (${kills} kills): ` +
      JSON.stringify({ tick, incidents, evictions, window, snakes: snakes?.map((x) => x.lifeId) }),
  );
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

/**
 * Runs batches until the room is `ticks` past where it is (it stays open: tests keep honest lives
 * queued for it). Fails instead of spinning if it doesn't get there.
 */
async function advance(name: string, ticks: number, max = 100): Promise<RoomStatus> {
  let s = await h.room<RoomStatus>(name, "runBatch");
  const target = s.tick + ticks;
  for (let i = 0; s.tick < target; i++) {
    if (s.state !== "running" || i >= max) {
      throw new Error(`room ${name} stopped at tick ${s.tick} (${s.state}), wanted ${target}`);
    }
    s = await h.room<RoomStatus>(name, "runBatch");
  }
  return s;
}

/** Honest lives queued for room `name` only, so it never runs out of real lives and closes. */
async function spares(name: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await h.call(
      "matchmaker",
      "offer",
      await ticket(`${name}-spare${i}`, house.medium as string),
      name,
    );
  }
}

/** Lives the room reported to the matchmaker as `evicted`. */
async function evictedLives(): Promise<LifeResult[]> {
  return (await events())
    .filter((e) => e.kind === "lifeEnded")
    .map((e) => e.body as LifeResult)
    .filter((l) => l.deathCause === "evicted");
}

describe("RoomDO backstop", () => {
  // Small CPU limit and batches, so "killed after 1.5 s" counts as CPU-limit evidence.
  const limits = { cpuLimitMs: 1000, batchTicks: 50 };
  const outcomes = (s: RoomStatus) => s.incidents.map((i) => i.outcome);
  const evictionKills = ["suspect", "suspect", "evicted"].slice(-KILLS_TO_EVICT);

  it("evicts a bot that blows the CPU limit by itself and quarantines it on its second life", async () => {
    const evil = await ticket("mallory", BOTS.hostile(120));
    const others = await Promise.all([
      ticket("kate", house.hard as string),
      ticket("liam", house.medium as string),
    ]);
    // Short replay chunks, so the evicted life's chunk reaches R2 within the test.
    await startRoom("backstop", [evil, ...others], { limits: { ...limits, chunkTicks: 100 } });
    // Its next lives, for when the first is evicted (a third in case the second dies of something
    // else before it burns).
    for (const n of [2, 3]) {
      await h.call("matchmaker", "offer", { ...evil, lifeId: `life-mallory-${n}` }, "backstop");
    }
    await spares("backstop", 3);

    // A normal batch dies (nobody to name), then every watched rerun dies in its call.
    const first = await drive("backstop", (s) => s.evictions.length > 0, { max: 200 });
    expect(first.kills).toBe(1 + KILLS_TO_EVICT);
    expect(outcomes(first.s)).toEqual(["overrun", ...evictionKills]);
    expect(first.s.evictions).toEqual([
      { versionId: evil.versionId, lifeId: evil.lifeId, tick: 120 },
    ]);
    expect(first.s.quarantined).toEqual([]);
    // Neutral: no strike, no ban, no D1 row; the matchmaker hears `evicted`.
    const next = await h.room<RoomStatus>("backstop", "runBatch");
    expect(next.snakes.map((x) => x.lifeId)).not.toContain(evil.lifeId);

    // Its second life does it again (still watched): evicted at once, and quarantined.
    const second = await drive("backstop", (s) => s.quarantined.length > 0, { max: 200 });
    expect(second.kills).toBe(KILLS_TO_EVICT);
    const [, again] = second.s.evictions.map((x) => x.lifeId);
    expect(second.s.evictions).toHaveLength(2);
    expect(["life-mallory-2", "life-mallory-3"]).toContain(again);
    expect(second.s.quarantined).toEqual([evil.versionId]);
    expect(
      await h.room("backstop", "join", { ...evil, lifeId: "evil-3", author: "mallory2" }),
    ).toEqual({ ok: false, reason: "quarantined" });

    // The room goes on with the others.
    let s = await advance("backstop", 50);
    expect(s.snakes.map((x) => x.lifeId)).not.toContain(again);
    expect(s.incidents).toHaveLength(1 + 2 * KILLS_TO_EVICT);

    // Like any life, the matchmaker hears of it once its replay chunk is in R2; D1 gets no row.
    for (let i = 0; i < 100 && !(await evictedLives()).some((l) => l.lifeId === evil.lifeId); i++) {
      s = await h.room<RoomStatus>("backstop", "runBatch");
    }
    expect((await evictedLives()).find((l) => l.lifeId === evil.lifeId)).toMatchObject({
      versionId: evil.versionId,
      endTick: expect.any(Number),
    });
    expect(await lifeRow(evil.lifeId)).toBeNull();
    const db = await h.d1();
    const version = await db
      .prepare(
        "SELECT status, quarantined_at, quarantine_reason, change_seq FROM versions WHERE id = ?",
      )
      .bind(evil.versionId)
      .first<{
        status: string;
        quarantined_at: number | null;
        quarantine_reason: string | null;
        change_seq: number;
      }>();
    // Quarantine isn't a ban: still `ready`, marked for every room and the matchmaker's poll.
    expect(version?.status).toBe("ready");
    expect(version?.quarantined_at).toEqual(expect.any(Number));
    expect(version?.quarantine_reason).toContain("Quarantined by the arena for review");
    const latest = await db
      .prepare("SELECT max(change_seq) AS m FROM versions")
      .first<{ m: number }>();
    expect(version?.change_seq).toBe(latest?.m);
    // Another room refuses it too.
    await h.room("backstop-elsewhere", "start", { roomId: "backstop-elsewhere", manual: true });
    expect(
      await h.room("backstop-elsewhere", "join", { ...evil, lifeId: "evil-4", author: "mal3" }),
    ).toEqual({ ok: false, reason: "quarantined" });
    const quarantine = (await events()).find((e) => e.kind === "versionQuarantined");
    expect(quarantine?.body as QuarantineRecord).toMatchObject({
      versionId: evil.versionId,
      lifeId: again,
      evictions: 2,
    });
  }, 240_000);

  it("evicts and quarantines a bot that only burns next to its real neighbours", async () => {
    // The reviewer's case: reruns of the room replay its neighbours exactly (every bot restarts
    // at the saved frame), so it burns again on every attempt.
    const fickle = await ticket("uma", BOTS.neighbours);
    const others = await Promise.all([
      ticket("vic", house.hard as string),
      ticket("wes", house.medium as string),
    ]);
    await startRoom("neighbours", [fickle, ...others], { limits });
    await h.call("matchmaker", "offer", { ...fickle, lifeId: "life-uma-2" }, "neighbours");
    await spares("neighbours", 3);

    const { kills, s } = await drive("neighbours", (s) => s.quarantined.length > 0, { max: 300 });
    expect(kills).toBe(1 + 2 * KILLS_TO_EVICT);
    expect(s.evictions.map((x) => x.lifeId)).toEqual([fickle.lifeId, "life-uma-2"]);
    expect(s.quarantined).toEqual([fickle.versionId]);

    // And the room makes progress.
    const after = await advance("neighbours", 100);
    expect(after.incidents).toHaveLength(kills);
    expect(after.snakes.map((x) => x.lifeId)).not.toContain("life-uma-2");
  }, 240_000);

  it("evicts colluders that take turns being named, within the room's cap of kills", async () => {
    // Three versions, each burning 20 ticks after every restart, but only on room ticks whose
    // residue mod 3 is its turn. A kill restarts all bots at the room's last saved frame, which
    // has moved on 20 ticks, so the kills name them in turn: a streak of kills naming one life
    // never started. The window counts them anyway, and its cap evicts all three.
    const colluders = await Promise.all(
      [0, 1, 2].map((turn) => ticket(`col${turn}`, BOTS.turns(turn, 3, 20))),
    );
    const others = await Promise.all([
      ticket("xena", house.hard as string),
      ticket("yuri", house.medium as string),
    ]);
    // Short batches, so the frame moves on between kills.
    await startRoom("colluders", [...colluders, ...others], {
      limits: { ...limits, batchTicks: 5 },
    });
    await spares("colluders", 3);

    const ids = colluders.map((c) => c.lifeId);
    const { kills, s } = await drive(
      "colluders",
      (s) => ids.every((id) => s.evictions.some((e) => e.lifeId === id)),
      { max: 300 },
    );
    // One unwatched kill, then at most the room's cap (plus a second round for one never named).
    expect(kills).toBeGreaterThan(KILLS_TO_EVICT);
    expect(kills).toBeLessThanOrEqual(1 + ROOM_KILLS_TO_EVICT + KILLS_TO_EVICT);
    expect(s.evictions.map((e) => e.lifeId).sort()).toEqual([...ids].sort());
    // More than one of them was named (the old streak would never have evicted any).
    const named = new Set(s.incidents.map((i) => i.versionId).filter((v) => v !== null));
    expect(named.size).toBeGreaterThan(1);
    expect(s.incidents.every((i) => !others.some((o) => o.versionId === i.versionId))).toBe(true);

    const after = await advance("colluders", 100);
    expect(after.incidents).toHaveLength(kills);
  }, 600_000);

  it("evicts a bot that only burns after many ticks of memory (restarts put it off)", async () => {
    // Each kill restarts it with empty memory, but it is the one named every time.
    const burner = await ticket("nina", BOTS.burnAfter(60));
    const other = await ticket("oscar", house.hard as string);
    await startRoom("burner", [burner, other], { limits });
    const { kills, s } = await drive("burner", (s) => s.evictions.length > 0, { max: 300 });
    expect(kills).toBe(1 + KILLS_TO_EVICT);
    expect(outcomes(s)).toEqual(["overrun", ...evictionKills]);
    expect(s.evictions.map((x) => x.lifeId)).toEqual([burner.lifeId]);
    // The evicted snake dies at the start of the next batch, without running again.
    const next = await h.room<RoomStatus>("burner", "runBatch");
    expect(next.snakes.map((x) => x.lifeId)).toContain(other.lifeId);
    expect(next.snakes.map((x) => x.lifeId)).not.toContain(burner.lifeId);
  }, 240_000);

  it("quarantines a bot that burns too rarely for the kill window to evict it", async () => {
    // The reviewer's periodic burner, scaled down: it burns once its memory has seen 60 ticks,
    // and a kill leaves the window after 100 ticks of progress (production: 1600 and 3000, see
    // `backstop.test.ts`). Every kill restarts it with no memory, so its kills land ~60 ticks
    // apart and the window never holds three. Its version's tally counts them all.
    const periodic = await ticket("pete", BOTS.burnAfter(60));
    const other = await ticket("rosa", house.hard as string);
    // Batches of 5 ticks, so each kill restarts it at most 5 ticks before its burn.
    await startRoom("periodic", [periodic, other], {
      limits: { ...limits, batchTicks: 5, killWindowTicks: 100 },
    });
    // More lives of the same version, in case one dies of something else between its burns: the
    // tally counts the version's kills across lives.
    for (const n of [2, 3]) {
      await h.call("matchmaker", "offer", { ...periodic, lifeId: `life-pete-${n}` }, "periodic");
    }
    await spares("periodic", 2);
    const { kills, s } = await drive("periodic", (s) => s.quarantined.length > 0, { max: 600 });
    // One unwatched kill names nobody; every watched one names it.
    expect(kills).toBe(1 + VERSION_KILLS_TO_QUARANTINE);
    const named = Array(VERSION_KILLS_TO_QUARANTINE - 1).fill("suspect");
    expect(outcomes(s)).toEqual(["overrun", ...named, "evicted"]);
    expect(s.kills.length).toBeLessThan(KILLS_TO_EVICT);
    expect(s.versionKills.map((k) => k.versionId)).toEqual(
      Array(VERSION_KILLS_TO_QUARANTINE).fill(periodic.versionId),
    );
    expect(s.evictions.map((x) => x.versionId)).toEqual([periodic.versionId]);
    expect(s.quarantined).toEqual([periodic.versionId]);

    // D1 has the same kills, which would quarantine it however its lives were spread over rooms.
    const after = await advance("periodic", 20);
    expect(after.incidents).toHaveLength(kills);
    const db = await h.d1();
    const rows = await db
      .prepare("SELECT room, retracted FROM version_kills WHERE version_id = ?")
      .bind(periodic.versionId)
      .all<{ room: string; retracted: number }>();
    expect(rows.results).toEqual(
      Array(VERSION_KILLS_TO_QUARANTINE).fill({ room: "periodic", retracted: 0 }),
    );
    const version = await db
      .prepare("SELECT quarantined_at FROM versions WHERE id = ?")
      .bind(periodic.versionId)
      .first<{ quarantined_at: number | null }>();
    expect(version?.quarantined_at).toEqual(expect.any(Number));
  }, 300_000);

  it("names a call that runs past the room's budget and returns, so the room can't stall", async () => {
    // The reviewer's probe: CPU limit 10 s, room budget 1 s, a bot spinning ~2.5 s in every tick.
    // Watch mode never lets it reach the CPU limit, but each of its calls runs past the abort
    // share; that used to abandon the tick and rerun it forever, naming nobody.
    const spinner = await ticket("sven", BOTS.slow(2500));
    const others = await Promise.all([
      ticket("tess", house.hard as string),
      ticket("ugo", house.medium as string),
    ]);
    await startRoom("spinner", [spinner, ...others], {
      limits: { cpuLimitMs: 10_000, cpuBudgetMs: 1000, batchTicks: 50 },
    });
    await h.call("matchmaker", "offer", { ...spinner, lifeId: "life-sven-2" }, "spinner");
    await spares("spinner", 3);

    // The first (normal) batch runs until it is killed, late enough to count as the CPU limit;
    // after that, each watched batch names the spinner's call and ends.
    const { kills, s } = await drive("spinner", (s) => s.quarantined.length > 0, {
      hangMs: 12_000,
      max: 60,
    });
    expect(kills).toBe(1);
    expect(outcomes(s)).toEqual(["overrun", ...evictionKills, ...evictionKills]);
    expect(s.evictions.map((x) => x.lifeId)).toEqual([spinner.lifeId, "life-sven-2"]);
    expect(s.quarantined).toEqual([spinner.versionId]);
    expect(
      s.incidents.every((i) => i.versionId === null || i.versionId === spinner.versionId),
    ).toBe(true);

    // And the room makes progress.
    const after = await advance("spinner", 100);
    expect(after.incidents).toHaveLength(s.incidents.length);
    expect(after.snakes.map((x) => x.lifeId)).not.toContain("life-sven-2");
  }, 300_000);

  it("never evicts or quarantines honest bots, however often the room is restarted", async () => {
    // The reviewer's repro: five honest versions, 40 restarts 0-300 ms into a batch, each
    // recovered after 1.5 s (longer than this room's CPU limit, so every crash looks like the
    // CPU limit, and timing can't spare anyone).
    // Each version has a bundle of its own, and instrumenting one takes 150 ms longer, as on a
    // slow CI machine: every restart lands while the room instruments them again, so this fails
    // if that's timed as the bots' `init`.
    const honest = await Promise.all(
      ["h5", "h6", "h7", "h8", "h9"].map((a) => ticket(a, `${house.hard}\n// ${a}\n`)),
    );
    await startRoom("storm", honest, { limits });
    await h.room("storm", "slowInstrument", 150);
    await h.room("storm", "runBatch");
    for (let i = 0; i < 40; i++) {
      void h.fire("storm", "runBatch");
      await sleep((i * 97) % 301);
      await h.restart();
      await sleep(1500);
    }
    const s = await h.room<RoomStatus>("storm", "runBatch");
    expect(s.incidents.filter((i) => i.outcome !== "restart").length).toBeGreaterThan(20);
    expect(s.evictions).toEqual([]);
    expect(s.quarantined).toEqual([]);
    // The kills that named them went to D1 too, and were retracted with the room's tally.
    const db = await h.d1();
    const ids = honest.map((t) => t.versionId);
    const marks = ids.map(() => "?").join(", ");
    const counted = await db
      .prepare(
        `SELECT version_id, sum(retracted = 0) AS n FROM version_kills
         WHERE version_id IN (${marks}) GROUP BY version_id`,
      )
      .bind(...ids)
      .all<{ version_id: string; n: number }>();
    for (const c of counted.results) expect(c.n).toBeLessThan(VERSION_KILLS_TO_QUARANTINE);
    const quarantined = await db
      .prepare(`SELECT id FROM versions WHERE quarantined_at IS NOT NULL AND id IN (${marks})`)
      .bind(...ids)
      .all();
    expect(quarantined.results).toEqual([]);
    const evicted = await evictedLives();
    expect(evicted.filter((l) => honest.some((t) => t.lifeId === l.lifeId))).toEqual([]);
    // The room goes on.
    await spares("storm", 2);
    await advance("storm", 100);
  }, 300_000);

  it("counts nothing when the room is restarted twice in a row (no CPU-limit evidence)", async () => {
    // Default 30 s CPU limit; a slow but honest bot just makes the batch long enough to interrupt.
    const slowpoke = await ticket("pia", BOTS.slow(30));
    const tom = await ticket("tom", house.hard as string);
    await startRoom("restarts", [slowpoke, tom], { limits: { batchTicks: 50 } });
    for (let i = 0; i < 2; i++) {
      void h.fire("restarts", "runBatch");
      await sleep(800);
      await h.restart();
    }
    const s = await h.room<RoomStatus>("restarts", "runBatch");
    expect(outcomes(s)).toEqual(["restart", "restart"]);
    expect(s.evictions).toEqual([]);
    expect(s.kills).toEqual([]);
    expect(s.watching).toBe(false);
    expect(s.tick).toBe(50);
    expect(s.snakes.map((x) => x.lifeId)).toEqual(
      expect.arrayContaining([slowpoke.lifeId, tom.lifeId]),
    );
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

  it("doesn't punish a bot for being slow: watch mode keeps the room going", async () => {
    // Slow every tick (~150 ms the meter doesn't see), so a normal batch overruns in aggregate.
    // Only the sandbox's meter may strike a bot; watch mode just keeps each invocation short.
    const slow = await ticket("quentin", BOTS.slow(150));
    const honest = await Promise.all([
      ticket("ruth", house.hard as string),
      ticket("sam", house.medium as string),
    ]);
    await startRoom("slow", [slow, ...honest], { limits: { cpuLimitMs: 2000, batchTicks: 50 } });
    const { kills, s } = await drive("slow", (s) => s.tick >= 80, { hangMs: 4000, max: 200 });
    expect(kills).toBe(1);
    expect(outcomes(s)).toEqual(["overrun"]);
    expect(s.watching).toBe(true);
    expect(s.evictions).toEqual([]);
    expect(s.snakes.map((x) => x.lifeId)).toContain(slow.lifeId);
  }, 180_000);
});
