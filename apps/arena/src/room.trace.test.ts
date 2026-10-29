/**
 * Life traces end to end (#25): a room records them, writes them to R2 `TRACES` through its
 * outbox before the life's row, and keeps recording across an eviction.
 */
import { gunzipSync } from "node:zlib";
import { type LifeTrace, TRACE_FULL_TICKS } from "@zerosnake/web/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LifeTicket, RoomStatus } from "./protocol.ts";
import { createHarness, type Harness, seedVersion } from "./testing/harness.ts";

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.dispose();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Circles, logs every tick, and starts throwing at life tick `at`: dies by `error` 2 ticks on. */
const doomed = (at: number) => `
  export default {
    init(info) { return { n: 0 }; },
    tick(state, mem, log) {
      mem.n++;
      log("tick " + state.lifeTick + " mem " + mem.n + " food " + state.food.length);
      if (state.lifeTick >= ${at}) throw new Error("planned at " + state.lifeTick);
      return { turn: 0.3, boost: state.lifeTick % 10 === 0 };
    },
  };`;

async function startRoom(name: string, tickets: LifeTicket[], limits: object = {}) {
  // Alone in the room (no house bots), so nothing else can kill it first.
  await h.room(name, "start", {
    roomId: name,
    seed: 7,
    manual: true,
    fillTo: 1,
    limits: { chunkTicks: 50, batchTicks: 40, ...limits },
  });
  for (const t of tickets) expect(await h.room(name, "join", t)).toEqual({ ok: true });
}

async function lifeRow(id: string) {
  const db = await h.d1();
  return db
    .prepare("SELECT end_tick, death_cause, trace_key FROM lives WHERE id = ?")
    .bind(id)
    .first<{ end_tick: number; death_cause: string; trace_key: string | null }>();
}

async function readTrace(key: string): Promise<LifeTrace> {
  const object = await (await h.traces()).get(key);
  if (!object) throw new Error(`no trace at ${key}`);
  expect(object.httpMetadata?.contentEncoding).toBe("gzip");
  return JSON.parse(gunzipSync(new Uint8Array(await object.arrayBuffer())).toString("utf8"));
}

/** Runs batches until the life has a row (or `max` batches). */
async function untilRow(name: string, lifeId: string, max = 30) {
  for (let i = 0; i < max; i++) {
    const row = await lifeRow(lifeId);
    if (row) return row;
    await h.room<RoomStatus>(name, "runBatch");
  }
  throw new Error(`no row for ${lifeId}`);
}

describe("RoomDO traces", () => {
  it("writes a dead life's trace to R2 before its row, last 100 ticks exact", async () => {
    const t = await seedVersion(await h.d1(), "tara", doomed(150));
    await startRoom("traced", [t]);
    const row = await untilRow("traced", t.lifeId);
    expect(row).toMatchObject({ death_cause: "error", end_tick: 153 });
    expect(row.trace_key).toMatch(/^\d{4}-\d{2}-\d{2}\/life-tara-1\.json\.gz$/);

    const trace = await readTrace(row.trace_key as string);
    expect(trace).toMatchObject({
      format: 1,
      lifeId: t.lifeId,
      versionId: t.versionId,
      roomId: "traced",
      startTick: 0,
      endTick: 153,
      cause: "error",
      killer: null,
      restarts: [],
    });
    expect(trace.totals).toMatchObject({ ticks: 153, errors: 3, timeouts: 0 });
    expect(trace.full).toHaveLength(TRACE_FULL_TICKS);
    trace.full.forEach((tick, i) => {
      const lifeTick = 53 + i;
      expect(tick.lifeTick).toBe(lifeTick);
      expect(tick.tick).toBe(lifeTick);
      expect(tick.log[0]).toMatch(new RegExp(`^tick ${lifeTick} mem ${lifeTick + 1} food \\d+$`));
      if (lifeTick < 150) expect(tick).toMatchObject({ outcome: "ok", turn: 0.3 });
      else
        expect(tick).toMatchObject({ outcome: "error", error: expect.stringContaining("planned") });
      expect(tick.work).toBeGreaterThan(0);
      expect(tick.seen.wall).toBeGreaterThan(0);
    });
    // The 53 earlier ticks: few enough to keep every one.
    expect(trace.sampleEvery).toBe(1);
    expect(trace.sampled.map((x) => x.lifeTick)).toEqual([...Array(53).keys()]);
    expect(trace.sampled[10]).toMatchObject({ boost: true });
  }, 60_000);

  it("retries a failed trace upload with backoff; the row waits for it", async () => {
    const t = await seedVersion(await h.d1(), "uma", doomed(5));
    await startRoom("flaky", [t]);
    await h.room("flaky", "failTraces", 2);
    // Dies at tick 8; the chunk closes at 50.
    let s = await h.room<RoomStatus>("flaky", "runBatch");
    s = await h.room<RoomStatus>("flaky", "runBatch");
    expect(s.outbox.failing).toBeGreaterThan(0);
    expect(await lifeRow(t.lifeId)).toBeNull();

    await sleep(1100);
    await h.room<RoomStatus>("flaky", "runBatch");
    // Second failure: the next try is 2 s after it.
    expect(await lifeRow(t.lifeId)).toBeNull();
    await sleep(2100);
    s = await h.room<RoomStatus>("flaky", "runBatch");
    const row = await lifeRow(t.lifeId);
    expect(row?.trace_key).toBeTruthy();
    expect((await readTrace(row?.trace_key as string)).totals.errors).toBe(3);
    expect(s.outbox.failing).toBe(0);
  }, 60_000);

  it("keeps every tick across an eviction and notes the bot's restart", async () => {
    const t = await seedVersion(await h.d1(), "vic", doomed(120));
    await startRoom("evicted", [t]);
    await h.room("evicted", "runBatch");
    await h.room("evicted", "runBatch");
    await h.restart();
    const row = await untilRow("evicted", t.lifeId);
    const trace = await readTrace(row.trace_key as string);
    expect(trace.restarts).toEqual([80]);
    expect(trace.totals.ticks).toBe(trace.endTick - trace.startTick);
    // Memory restarted with the bot; the world (and the trace) didn't.
    expect(trace.full.find((x) => x.lifeTick === 80)?.log[0]).toMatch(/^tick 80 mem 1 /);
    expect(trace.full.find((x) => x.lifeTick === 79)?.log[0]).toMatch(/^tick 79 mem 80 /);
  }, 60_000);
});
