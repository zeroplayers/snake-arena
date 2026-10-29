import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHouseBots } from "../scripts/house-bundles.ts";
import type { LifeTicket, RoomStatus } from "./protocol.ts";
import { KILLS_TO_EVICT } from "./room/backstop.ts";
import { BOTS, createHarness, type Harness, seedVersion } from "./testing/harness.ts";
import { type DataPoint, metricsNamed, readPoint } from "./testing/metrics.ts";

let h: Harness;
let house: Record<string, string>;

beforeAll(async () => {
  [h, house] = await Promise.all([createHarness({ metrics: "record" }), bundleHouseBots()]);
}, 120_000);

afterAll(async () => {
  await h?.dispose();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ticket(author: string, source: string): Promise<LifeTicket> {
  return seedVersion(await h.d1(), author, source);
}

async function startRoom(name: string, tickets: LifeTicket[], options: object = {}) {
  await h.room(name, "start", { roomId: name, seed: 7, manual: true, ...options });
  for (const t of tickets) expect(await h.room(name, "join", t)).toEqual({ ok: true });
}

const points = (name: string) => h.room<DataPoint[]>(name, "metricPoints");
const run = (name: string) => h.room<RoomStatus>(name, "runBatch");

async function setPaused(paused: number) {
  const db = await h.d1();
  await db.prepare("UPDATE arena_control SET paused = ? WHERE id = 1").bind(paused).run();
}

/** Stops the arena for one batch: the room retires its lives and closes. */
async function stopRoom(name: string): Promise<RoomStatus> {
  await setPaused(1);
  try {
    return await run(name);
  } finally {
    await setPaused(0);
  }
}

describe("RoomDO metrics", () => {
  it("writes room.started, room.batch per batch, life.ended once delivered, room.closed", async () => {
    const dave = await ticket("dave", BOTS.thrower);
    // Erin circles in open space: she can't die before the stop, whatever the rules. Three house
    // bots, not a full room's crowd, so the space stays open.
    const erin = await ticket("erin", BOTS.circler);
    await startRoom("metered", [dave, erin], {
      fillTo: 5,
      limits: { chunkTicks: 50, metricsMs: 0, arenaControlPollMs: 0 },
    });
    let s = await run("metered");
    const first = await points("metered");
    expect(first.every((p) => readPoint(p).source === "arena")).toBe(true);
    expect(metricsNamed(first, "room.started")).toEqual([
      { roomId: "metered", mode: "accelerated", maxSnakes: 20 },
    ]);
    const [batch] = metricsNamed(first, "room.batch");
    expect(batch).toMatchObject({
      roomId: "metered",
      mode: "accelerated",
      batches: 1,
      ticks: s.tick,
      tick: s.tick,
      livesStarted: 2,
      // Dave throws every tick: dead by `error` on his third.
      livesEnded: 1,
      snakes: s.snakes.length,
      // Erin; house bots fill the other slots (3 spawned with the two tickets).
      realLives: 1,
      houseRetired: 0,
      spectators: 0,
      watched: 0,
      cut: 0,
    });
    expect(s.snakes.length + s.livesEnded).toBe(5);
    // Sandboxed bot ticks only (Dave's 3 and Erin's): house bots run natively.
    expect(batch?.botTicks).toBe(s.tick + 3);
    expect(batch?.workUnits).toBeGreaterThan(0);
    expect(batch?.periodMs).toBeGreaterThanOrEqual(0);
    expect(batch?.wallMs).toBeGreaterThanOrEqual(0);

    // Dave's life is written once its replay chunk is in R2.
    for (
      let i = 0;
      i < 20 && metricsNamed(await points("metered"), "life.ended").length === 0;
      i++
    ) {
      s = await run("metered");
    }
    expect(metricsNamed(await points("metered"), "life.ended")).toEqual([
      {
        versionId: dave.versionId,
        deathCause: "error",
        roomId: "metered",
        score: expect.any(Number),
        ticks: 3,
        kills: 0,
        durationMs: expect.any(Number),
      },
    ]);

    const closed = await stopRoom("metered");
    expect(closed.state).toBe("closed");
    const all = await points("metered");
    const batches = metricsNamed(all, "room.batch");
    // Every batch is counted once, closing included.
    expect(batches.reduce((n, b) => n + Number(b.ticks), 0)).toBe(closed.tick);
    expect(batches.reduce((n, b) => n + Number(b.livesEnded), 0)).toBe(2);
    expect(metricsNamed(all, "room.closed")).toEqual([
      {
        roomId: "metered",
        reason: "kill_switch",
        ticks: closed.tick,
        // Dave and Erin: the house bots that died in it aren't counted.
        lives: 2,
        durationMs: expect.any(Number),
      },
    ]);
    // Erin was retired by the stop, and both lives were delivered with their cause.
    for (let i = 0; i < 5 && metricsNamed(await points("metered"), "life.ended").length < 2; i++) {
      await run("metered");
    }
    expect(
      metricsNamed(await points("metered"), "life.ended").map((l) => [l.versionId, l.deathCause]),
    ).toEqual([
      [dave.versionId, "error"],
      [erin.versionId, "retired"],
    ]);
  }, 60_000);

  it("sums the batches of a period into one room.batch", async () => {
    const tickets = await Promise.all(["fay", "gus"].map((a) => ticket(a, house.hard as string)));
    // The default period (30 s) is longer than this test: only closing writes the sums.
    await startRoom("summed", tickets, { limits: { batchTicks: 20, arenaControlPollMs: 0 } });
    for (let i = 0; i < 3; i++) await run("summed");
    expect(metricsNamed(await points("summed"), "room.batch")).toEqual([]);
    const closed = await stopRoom("summed");
    expect(metricsNamed(await points("summed"), "room.batch")).toEqual([
      expect.objectContaining({ roomId: "summed", batches: 4, ticks: 80, tick: closed.tick }),
    ]);
  }, 60_000);

  it("counts the house snakes retired to make way for real lives", async () => {
    const [una, vic, wes] = await Promise.all(
      ["una", "vic", "wes"].map((a) => ticket(a, BOTS.circler)),
    );
    if (!una || !vic || !wes) throw new Error("no tickets");
    await startRoom("retiring", [una], {
      maxSnakes: 3,
      limits: { batchTicks: 10, metricsMs: 0, arenaControlPollMs: 0 },
    });
    await run("retiring");
    expect(await h.room("retiring", "join", vic)).toEqual({ ok: true });
    expect(await h.room("retiring", "join", wes)).toEqual({ ok: true });
    const s = await run("retiring");
    expect(s.snakes.filter((x) => x.house)).toEqual([]);
    expect(
      metricsNamed(await points("retiring"), "room.batch").map((b) => [
        b.houseRetired,
        b.realLives,
        b.snakes,
      ]),
    ).toEqual([
      [0, 1, 3],
      [2, 3, 3],
    ]);
  }, 60_000);

  it("writes room.crashed for every incident, room.evicted when a life is evicted", async () => {
    const evil = await ticket("mallory", BOTS.hostile(30));
    const others = await Promise.all([
      ticket("kate", house.hard as string),
      ticket("liam", house.medium as string),
    ]);
    // Small CPU limit and batches, so "killed after 1.5 s" counts as CPU-limit evidence. Few
    // house bots, so watched batches of honest calls stay well within the harness's 4 s.
    await startRoom("crashy", [evil, ...others], {
      fillTo: 5,
      limits: { cpuLimitMs: 1000, batchTicks: 50, metricsMs: 0 },
    });
    let s: RoomStatus | null = null;
    for (let i = 0; i < 200 && !s?.evictions.length; i++) {
      const finished = await Promise.race([
        h.fire("crashy", "runBatch").then(() => true),
        sleep(4000).then(() => false),
      ]);
      if (!finished) await h.restart();
      s = await h.room<RoomStatus>("crashy", "status");
    }
    const all = await points("crashy");
    const crashes = metricsNamed(all, "room.crashed");
    // A normal batch dies (nobody to name), then every watched rerun dies in its call.
    expect(crashes.map((c) => c.cause)).toEqual([
      "overrun",
      ...["suspect", "suspect", "evicted"].slice(-KILLS_TO_EVICT),
    ]);
    expect(crashes.map((c) => c.restarts)).toEqual(crashes.map((_, i) => i + 1));
    expect(crashes[0]).toMatchObject({ roomId: "crashy", versionId: null, callMs: 0 });
    expect(crashes.at(-1)).toMatchObject({ versionId: evil.versionId });
    for (const c of crashes) expect(c.gapMs).toBeGreaterThan(900);
    expect(metricsNamed(all, "room.evicted")).toEqual([
      { roomId: "crashy", versionId: evil.versionId, evictions: 1, versionKills: KILLS_TO_EVICT },
    ]);
    // The batches in watch mode are counted as such.
    const batches = metricsNamed(all, "room.batch");
    expect(batches.some((b) => Number(b.watched) > 0)).toBe(true);
  }, 240_000);

  it("writes a restart as room.crashed with cause restart", async () => {
    const slowpoke = await ticket("pia", BOTS.slow(30));
    const tom = await ticket("tom", house.hard as string);
    await startRoom("restarted", [slowpoke, tom], { limits: { batchTicks: 50 } });
    void h.fire("restarted", "runBatch");
    await sleep(800);
    await h.restart();
    await run("restarted");
    expect(metricsNamed(await points("restarted"), "room.crashed")).toEqual([
      {
        roomId: "restarted",
        cause: "restart",
        versionId: null,
        restarts: 1,
        gapMs: expect.any(Number),
        callMs: 0,
      },
    ]);
  }, 60_000);
});

describe("RoomDO metrics, accuracy", () => {
  it("times the simulation as wallMs, not the deliveries before it", async () => {
    const SLOW_MS = 2500;
    const hal = await ticket("hal", BOTS.thrower);
    const ivy = await ticket("ivy", house.hard as string);
    await startRoom("timed", [hal, ivy], {
      limits: { batchTicks: 20, metricsMs: 0, arenaControlPollMs: 0 },
    });
    // Hal dies on his third tick; his trace's upload fails and is retried a second later...
    await h.room("timed", "failTraces", 1);
    await run("timed");
    // ...by the next cycle, before its batch, and takes SLOW_MS.
    await h.room("timed", "slowTraces", SLOW_MS);
    await sleep(1100);
    const before = (await points("timed")).length;
    const from = performance.now();
    await run("timed");
    expect(performance.now() - from).toBeGreaterThanOrEqual(SLOW_MS);
    const [batch] = metricsNamed((await points("timed")).slice(before), "room.batch");
    expect(batch).toMatchObject({ batches: 1, ticks: 20 });
    expect(batch?.wallMs).toBeLessThan(SLOW_MS);
    expect(batch?.maxWallMs).toBe(batch?.wallMs);
  }, 60_000);

  it("delivers at most outboxPerCycle items a cycle, so life.ended stays under the cap", async () => {
    const throwers = await Promise.all(
      ["jo", "kim", "lee", "mo"].map((a) => ticket(a, BOTS.thrower)),
    );
    const ned = await ticket("ned", house.hard as string);
    await startRoom("capped", [...throwers, ned], {
      limits: {
        batchTicks: 20,
        chunkTicks: 50,
        metricsMs: 0,
        arenaControlPollMs: 0,
        outboxPerCycle: 2,
      },
    });
    const lives = async () => metricsNamed(await points("capped"), "life.ended").length;
    // Four lives end on tick 3: four traces, four lives and the chunks, two items a cycle.
    const perCycle: number[] = [];
    for (let i = 0; i < 30 && (await lives()) < throwers.length; i++) {
      const before = await lives();
      await run("capped");
      perCycle.push((await lives()) - before);
    }
    expect(await lives()).toBe(throwers.length);
    expect(Math.max(...perCycle)).toBeLessThanOrEqual(2);
    expect(perCycle.filter((n) => n > 0).length).toBeGreaterThan(1);
  }, 120_000);

  it("writes one room.crashed for an alarm that threw, not a second one on recovery", async () => {
    const pat = await ticket("pat", house.hard as string);
    const quin = await ticket("quin", house.medium as string);
    await startRoom("thrown", [pat, quin], { limits: { batchTicks: 20, metricsMs: 0 } });
    // The batch throws after its marker is saved: the next cycle recovers from it.
    await h.room("thrown", "failInstrument", 1);
    await expect(run("thrown")).rejects.toThrow(/instrumenting failed/);
    const s = await run("thrown");
    expect(s.tick).toBe(20);
    const crashes = metricsNamed(await points("thrown"), "room.crashed");
    expect(crashes).toEqual([
      expect.objectContaining({ roomId: "thrown", cause: "exception", versionId: null }),
    ]);
  }, 60_000);
});

describe("RoomDO metrics, fail-open", () => {
  it("runs, delivers and closes when every metric write throws", async () => {
    const broken = await createHarness({ metrics: "throw" });
    try {
      const t = await seedVersion(await broken.d1(), "olga", BOTS.thrower);
      await broken.room("broken", "start", {
        roomId: "broken",
        seed: 7,
        manual: true,
        limits: { chunkTicks: 50, metricsMs: 0 },
      });
      expect(await broken.room("broken", "join", t)).toEqual({ ok: true });
      let s = await broken.room<RoomStatus>("broken", "runBatch");
      expect(s.tick).toBeGreaterThan(0);
      for (let i = 0; i < 20 && s.state === "running"; i++) {
        s = await broken.room<RoomStatus>("broken", "runBatch");
      }
      // Only house bots were left: the room closed, and Olga's life reached D1.
      expect(s.state).toBe("closed");
      const db = await broken.d1();
      expect(
        await db.prepare("SELECT death_cause FROM lives WHERE id = ?").bind(t.lifeId).first(),
      ).toEqual({ death_cause: "error" });
      expect(await broken.room("broken", "metricPoints")).toEqual([]);
    } finally {
      await broken.dispose();
    }
  }, 60_000);
});
