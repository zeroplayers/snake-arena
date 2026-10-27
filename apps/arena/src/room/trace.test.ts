import type { BotLife, TickReport } from "@zerosnake/sandbox";
import type { BotState } from "@zerosnake/sdk";
import {
  type LifeTrace,
  TRACE_EVENTS_MAX,
  TRACE_FULL_TICKS,
  TRACE_MAX_BYTES,
  TRACE_SAMPLED_LOG_BYTES,
  TRACE_SAMPLED_MAX,
  traceTicks,
  utf8Bytes,
} from "@zerosnake/web/shared";
import { describe, expect, it } from "vitest";
import { sweepTraces } from "../traces.ts";
import { summarize, TraceRecorder, type TraceState } from "./trace.ts";

const life = (log: string[] = [], death: string | null = null) =>
  ({
    loadLog: { lines: log, truncated: false },
    death: death ? { fault: "error", reason: "load", message: death } : null,
  }) as unknown as BotLife;

function recorder(log: string[] = []): TraceRecorder {
  return TraceRecorder.start(
    {
      lifeId: "life-1",
      versionId: "v-1",
      roomId: "room",
      startTick: 50,
      budget: { ops: 100, work: 1e8, logBytes: 1024 },
    },
    life(log),
  );
}

function state(lifeTick: number, extra: Partial<BotState> = {}): BotState {
  return {
    tick: 50 + lifeTick,
    lifeTick,
    self: {
      id: "life-1",
      head: { x: 10, y: 0 },
      angle: 0.5,
      length: 20,
      speed: 1,
      radius: 0.5,
      turnRate: 0.1,
      boosting: false,
      segments: [{ x: 10, y: 0 }],
    },
    snakes: [],
    food: [],
    wallDistance: 90,
    ...extra,
  };
}

function report(lifeTick: number, extra: Partial<TickReport> = {}): TickReport {
  return {
    action: { turn: (lifeTick % 7) / 7 - 0.5, boost: lifeTick % 3 === 0 },
    outcome: "ok",
    error: null,
    interrupts: lifeTick % 50,
    work: lifeTick * 1000,
    log: { lines: [`t${lifeTick}`], truncated: false },
    strikes: 0,
    errors: 0,
    death: null,
    ...extra,
  };
}

const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as LifeTrace;
const END = { endTick: 0, cause: "wall", killer: null };

describe("TraceRecorder", () => {
  it("keeps the last 100 ticks exactly and downsamples the rest within its bounds", () => {
    const r = recorder();
    const n = 5000;
    for (let t = 0; t < n; t++) {
      const failed = t % 97 === 5;
      r.record(
        state(t),
        report(
          t,
          failed
            ? { outcome: "error", error: `boom ${t}`, log: { lines: [], truncated: false } }
            : {},
        ),
      );
    }
    const trace = decode(r.finish({ ...END, endTick: 50 + n }));

    expect(trace.full).toHaveLength(TRACE_FULL_TICKS);
    trace.full.forEach((tick, i) => {
      const t = n - TRACE_FULL_TICKS + i;
      const want = report(t);
      expect(tick).toMatchObject({
        tick: 50 + t,
        lifeTick: t,
        turn: Math.round(want.action.turn * 1000) / 1000,
        boost: want.action.boost,
        work: want.work,
        ops: want.interrupts,
      });
      if (t % 97 === 5) expect(tick).toMatchObject({ outcome: "error", error: `boom ${t}` });
      else expect(tick.log).toEqual([`t${t}`]);
    });

    expect(trace.sampled.length).toBeLessThanOrEqual(TRACE_SAMPLED_MAX);
    expect(trace.sampled.length).toBeGreaterThan(TRACE_SAMPLED_MAX / 2);
    expect(trace.sampled[0]?.lifeTick).toBe(0);
    for (const tick of trace.sampled) {
      expect(tick.lifeTick % trace.sampleEvery).toBe(0);
      expect(tick.lifeTick).toBeLessThan(n - TRACE_FULL_TICKS);
    }
    // Errors that fell out of the sampled ticks: the latest ones, within the cap.
    expect(trace.events).toHaveLength(TRACE_EVENTS_MAX);
    expect(trace.events.every((e) => e.outcome === "error")).toBe(true);
    expect(trace.events.at(-1)?.lifeTick).toBe(4855);
    const all = traceTicks(trace).map((t) => t.tick);
    expect(all).toEqual([...all].sort((a, b) => a - b));

    expect(trace.totals).toMatchObject({
      ticks: n,
      errors: Math.ceil((n - 5) / 97),
      maxWork: (n - 1) * 1000,
      maxOps: 49,
    });
    expect(trace).toMatchObject({ lifeId: "life-1", startTick: 50, cause: "wall", format: 1 });
  });

  it("stays under its size cap however much a bot logs", () => {
    const r = recorder(['"'.repeat(1024)]);
    // `"` doubles in JSON; control characters would be six bytes each but become `?`.
    const quotes = '"\\'.repeat(512);
    const id = "x".repeat(64);
    const enemy = {
      id,
      author: "a".repeat(39),
      length: 1e6,
      radius: 1,
      head: { x: 1, y: 1 },
      angle: 0,
      boosting: true,
      segments: [{ x: 1, y: 1 }],
    };
    for (let t = 0; t < 20_000; t++) {
      r.record(
        state(t, { snakes: [enemy], food: [{ x: 3, y: 4, value: 1 }] }),
        report(t, {
          outcome: t % 2 ? "timeout" : "error",
          error: "\u0001".repeat(2000),
          work: 1e15,
          interrupts: 1e9,
          log: { lines: [quotes], truncated: true },
        }),
      );
    }
    const bytes = r.finish({ ...END, cause: "collision", killer: id });
    expect(bytes.length).toBeLessThanOrEqual(TRACE_MAX_BYTES);
    // Never needed to trim: the bounds hold by construction.
    const trace = decode(bytes);
    expect(trace.trimmed).toBeUndefined();
    expect(trace.full.at(-1)?.log).toEqual([quotes]);
    expect(trace.full.at(-1)?.error).toBe("?".repeat(300));
    for (const t of trace.sampled) {
      expect(t.log.reduce((n, l) => n + utf8Bytes(l), 0)).toBeLessThanOrEqual(
        TRACE_SAMPLED_LOG_BYTES,
      );
      expect(t.logCut).toBe(true);
    }
  });

  it("trims the oldest logs if a trace would go over the cap anyway", () => {
    const r = recorder();
    for (let t = 0; t < TRACE_FULL_TICKS; t++) r.record(state(t), report(t));
    // A state saved by some older build with bigger logs.
    for (const tick of r.state.full) tick.log = ["y".repeat(10_000)];
    const trace = decode(r.finish(END));
    expect(trace.trimmed).toBe(true);
    expect(JSON.stringify(trace).length).toBeLessThanOrEqual(TRACE_MAX_BYTES);
    expect(trace.full.at(-1)?.log).toEqual(["y".repeat(10_000)]);
    expect(trace.full[0]?.log).toEqual([]);
  });

  it("survives a save and reload, and notes restarts", () => {
    const r = recorder(["hello from init"]);
    for (let t = 0; t < 150; t++) r.record(state(t), report(t));
    const saved = JSON.parse(JSON.stringify(r.state)) as TraceState;
    const again = new TraceRecorder(saved);
    again.restart(200, life(["init again"]));
    for (let t = 150; t < 300; t++) again.record(state(t), report(t));
    const fresh = recorder(["hello from init"]);
    for (let t = 0; t < 300; t++) fresh.record(state(t), report(t));

    const a = decode(again.finish(END));
    const b = decode(fresh.finish(END));
    expect(a.restarts).toEqual([200]);
    expect(a.load.log).toEqual(["hello from init"]);
    expect({ ...a, restarts: [] }).toEqual(b);
  });

  it("summarizes what the bot saw", () => {
    const seen = summarize(
      state(3, {
        snakes: [
          {
            id: "far",
            author: "bob",
            length: 30,
            radius: 0.5,
            head: null,
            angle: null,
            boosting: false,
            segments: [{ x: 30, y: 0 }],
          },
          {
            id: "near",
            author: "eve",
            length: 12.4,
            radius: 0.5,
            head: { x: 13, y: 4 },
            angle: 1,
            boosting: false,
            segments: [
              { x: 13, y: 4 },
              { x: 12, y: 1 },
            ],
          },
        ],
        food: [
          { x: 10, y: 5, value: 1 },
          { x: 10, y: -2, value: 1 },
        ],
      }),
    );
    expect(seen).toEqual({
      x: 10,
      y: 0,
      angle: 0.5,
      length: 20,
      wall: 90,
      snakes: 2,
      food: 2,
      nearest: { id: "near", author: "eve", gap: 1.24, length: 12, head: true },
      foodDist: 2,
    });
  });
});

describe("sweepTraces", () => {
  it("deletes days past retention, oldest first, and stops at the first young key", async () => {
    const keys = [
      "2026-10-01/a.json.gz",
      "2026-10-19/b.json.gz",
      "2026-10-20/c.json.gz",
      "2026-10-27/d.json.gz",
    ];
    const deleted: string[] = [];
    let lists = 0;
    const bucket = {
      async list({ cursor }: { cursor?: string }) {
        lists++;
        const at = cursor ? Number(cursor) : 0;
        const page = keys.slice(at, at + 1).map((key) => ({ key }));
        return { objects: page, truncated: at + 1 < keys.length, cursor: String(at + 1) };
      },
      async delete(batch: string[]) {
        deleted.push(...batch);
      },
    } as unknown as R2Bucket;
    const n = await sweepTraces(bucket, Date.parse("2026-10-27T12:00:00Z"));
    expect(deleted).toEqual(["2026-10-01/a.json.gz", "2026-10-19/b.json.gz"]);
    expect(n).toBe(2);
    expect(lists).toBe(3);
  });
});
