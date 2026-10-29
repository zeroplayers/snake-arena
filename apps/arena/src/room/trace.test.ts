import { DatabaseSync } from "node:sqlite";
import type { BotLife, TickReport } from "@zerosnake/sandbox";
import type { BotState } from "@zerosnake/sdk";
import {
  jsonBytes,
  type LifeTrace,
  TRACE_EVENTS_MAX,
  TRACE_FULL_TICKS,
  TRACE_LINE_OVERHEAD,
  TRACE_MAX_BYTES,
  TRACE_SAMPLED_LOG_BYTES,
  TRACE_SAMPLED_MAX,
  TRACE_TICK_LOG_BYTES,
  type TraceTick,
  traceTicks,
  utf8Bytes,
} from "@zerosnake/web/shared";
import { describe, expect, it } from "vitest";
import { sweepTraces } from "../traces.ts";
import { summarize, TraceRecorder, type TraceState } from "./trace.ts";
import { type TraceSql, TraceStore } from "./trace-store.ts";

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
      spawnGrace: 0,
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

/** JSON bytes of a tick's log as stored (lines, escapes and per-line overhead). */
const logJson = (t: { log: string[] }) =>
  t.log.reduce((n, l) => n + jsonBytes(l) + TRACE_LINE_OVERHEAD, 0);

/** An enemy as big as JSON gets: long id and author, huge length. */
const ENEMY = {
  id: "x".repeat(64),
  author: "a".repeat(39),
  length: 1e6,
  radius: 1,
  head: { x: 1, y: 1 },
  angle: 0,
  boosting: true,
  spawnGrace: 0,
  segments: [{ x: 1, y: 1 }],
};

/** Worst-case ticks: an enemy in sight, failing, 2000 bytes of error, logging `lines`. */
function worst(r: TraceRecorder, from: number, to: number, lines: (t: number) => string[]): void {
  for (let t = from; t < to; t++) {
    r.record(
      state(t, { snakes: [ENEMY], food: [{ x: 3, y: 4, value: 1 }] }),
      report(t, {
        outcome: t % 2 ? "timeout" : "error",
        error: "\u0001".repeat(2000),
        work: 1e15,
        interrupts: 1e9,
        log: { lines: lines(t), truncated: true },
      }),
    );
  }
}

/** What the sandbox lets a bot log in one tick (1 KB, each line at least one byte). */
const LOGS: Record<string, (t: number) => string[]> = {
  'empty lines: log("") × 1024': () => Array(1024).fill(""),
  "quotes: log('\"') × 1024": () => Array(1024).fill('"'),
  "tabs: log('\\t') × 1024": () => Array(1024).fill("\t"),
  "mixed: short lines, escapes, one long line": (t) => [
    ...Array(600).fill(""),
    ...Array(200).fill('"'),
    '"\\'.repeat(100),
    `tick ${t}`,
  ],
  "one line of 1 KB of escapes": () => ['"\\'.repeat(512)],
};

/** node:sqlite as the room's `SqlStorage`. */
function sqlite(): TraceSql {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...bindings) {
      if (bindings.length === 0 && !/^\s*SELECT/i.test(query)) {
        db.exec(query);
        return { toArray: () => [] };
      }
      const st = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const rows = st.all(...(bindings as never[]));
        return { toArray: () => rows as never[] };
      }
      st.run(...(bindings as never[]));
      return { toArray: () => [] };
    },
  };
}

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
      spawnGrace: 0,
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

  for (const [name, lines] of Object.entries(LOGS)) {
    it(`stays under its size cap with many lines per tick (${name})`, () => {
      const r = recorder(lines(0));
      worst(r, 0, 6000, lines);
      // What the room keeps between batches is bounded by the same budgets.
      expect(utf8Bytes(JSON.stringify(r.state))).toBeLessThan(TRACE_MAX_BYTES);
      const bytes = r.finish({ ...END, cause: "collision", killer: ENEMY.id });
      expect(bytes.length).toBeLessThanOrEqual(TRACE_MAX_BYTES);
      const trace = decode(bytes);
      // Never needed to trim: every full-window tick keeps its log.
      expect(trace.trimmed).toBeUndefined();
      expect(trace.full).toHaveLength(TRACE_FULL_TICKS);
      for (const t of trace.full) {
        expect(t.log.length).toBeGreaterThan(0);
        expect(logJson(t)).toBeLessThanOrEqual(TRACE_TICK_LOG_BYTES);
        expect(t.logCut).toBe(true);
      }
      expect(logJson(trace.load)).toBeLessThanOrEqual(TRACE_TICK_LOG_BYTES);
      for (const t of [...trace.sampled, ...trace.events]) {
        expect(logJson(t)).toBeLessThanOrEqual(TRACE_SAMPLED_LOG_BYTES);
        expect(jsonBytes(t.error ?? "")).toBeLessThanOrEqual(TRACE_SAMPLED_LOG_BYTES);
      }
    });
  }

  it("keeps the sandbox's whole 1 KB per tick when it isn't split into many lines", () => {
    const r = recorder();
    const lines = ['"\\'.repeat(256), "x".repeat(400), "\t".repeat(100)];
    r.record(state(0), report(0, { log: { lines, truncated: false } }));
    const tick = decode(r.finish(END)).full[0];
    expect(tick?.log).toEqual(lines);
    expect(tick?.logCut).toBeUndefined();
  });

  it("charges lines their JSON size: what doesn't fit is cut and marked", () => {
    const r = recorder();
    r.record(state(0), report(0, { log: { lines: Array(1024).fill(""), truncated: false } }));
    const tick = decode(r.finish(END)).full[0] as TraceTick;
    // 2 bytes of quotes and 1 of comma per line (the last line's comma pays for the brackets).
    expect(tick.log).toHaveLength(Math.floor(TRACE_TICK_LOG_BYTES / TRACE_LINE_OVERHEAD));
    expect(tick.logCut).toBe(true);
  });

  it("trims older logs first if a trace would go over the cap anyway", () => {
    const r = recorder();
    for (let t = 0; t < 1000; t++) r.record(state(t), report(t));
    // States saved by some older build with bigger logs: the downsampled ticks' go first.
    for (const tick of r.state.sampled) tick.log = ["s".repeat(8000)];
    let trace = decode(r.finish(END));
    expect(trace.trimmed).toBe(true);
    expect(JSON.stringify(trace).length).toBeLessThanOrEqual(TRACE_MAX_BYTES);
    expect(trace.sampled[0]?.log).toEqual([]);
    expect(trace.sampled.at(-1)?.log).toEqual(["s".repeat(8000)]);
    expect(trace.full.every((t) => t.log.length === 1 && t.log[0] === `t${t.lifeTick}`)).toBe(true);

    // And the full window's, oldest first, only once nothing older is left.
    for (const tick of r.state.full) tick.log = ["y".repeat(10_000)];
    trace = decode(r.finish(END));
    expect(JSON.stringify(trace).length).toBeLessThanOrEqual(TRACE_MAX_BYTES);
    expect(trace.sampled.every((t) => t.log.length === 0)).toBe(true);
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

  it("survives a reload from its saved rows, deleting rows that left on either side", () => {
    const sql = sqlite();
    const store = new TraceStore(sql);
    const r = recorder(["hello from init"]);
    for (let t = 0; t < 450; t++) {
      r.record(state(t), report(t));
      if (t % 10 === 9) store.save("life-1", r.changes());
    }
    const again = store.load()["life-1"] as TraceRecorder;
    expect(again.state).toEqual(r.state);
    again.restart(500, life(["init again"]));
    for (let t = 450; t < 900; t++) {
      again.record(state(t), report(t));
      if (t % 10 === 9) store.save("life-1", again.changes());
    }
    expect(store.load()["life-1"]?.state).toEqual(again.state);
    const rows = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM trace_rows").toArray()[0];
    const s = again.state;
    expect(rows?.n).toBe(2 + s.full.length + s.sampled.length + s.events.length);

    const fresh = recorder(["hello from init"]);
    for (let t = 0; t < 900; t++) fresh.record(state(t), report(t));
    const a = decode(again.finish(END));
    expect(a.restarts).toEqual([500]);
    expect({ ...a, restarts: [] }).toEqual(decode(fresh.finish(END)));

    store.delete("life-1");
    expect(store.load()).toEqual({});
  });

  for (const [mode, batch] of [
    ["real time", 10],
    ["accelerated", 500],
  ] as const) {
    it(`saves only what changed in each batch, bounded (${mode}, ${batch} ticks)`, () => {
      const store = new TraceStore(sqlite());
      const lines = LOGS["mixed: short lines, escapes, one long line"] as (t: number) => string[];
      const r = recorder(lines(0));
      // The first batch also writes the load log.
      let most = 0;
      let first = 0;
      for (let from = 0; from < 6000; from += batch) {
        worst(r, from, from + batch, lines);
        const bytes = store.save("life-1", r.changes());
        if (from === 0) first = bytes;
        else most = Math.max(most, bytes);
        if (from % 1000 === 0) expect(store.load()["life-1"]?.state).toEqual(r.state);
      }
      // A batch writes each of its ticks at most once in full and once downsampled (events too,
      // all of them when the stride doubles), plus the head and, the first, the load log: in
      // proportion to the batch, never more than the whole trace.
      const size = (ticks: TraceTick[]) =>
        Math.max(...ticks.map((t) => utf8Bytes(JSON.stringify(t))));
      const tick = size(r.state.full);
      const shrunk = size([...r.state.sampled, ...r.state.events]);
      const head = 1024;
      const bound =
        Math.min(batch, TRACE_FULL_TICKS) * tick +
        Math.min(batch, TRACE_SAMPLED_MAX) * shrunk +
        TRACE_EVENTS_MAX * shrunk +
        head;
      expect(first).toBeLessThanOrEqual(bound + TRACE_TICK_LOG_BYTES);
      expect(most).toBeLessThanOrEqual(bound);
      expect(most).toBeLessThan(TRACE_MAX_BYTES);
      expect(store.load()["life-1"]?.state).toEqual(r.state);
    });
  }

  it("stores logs and errors printable: no control, C1, bidi or lone surrogate characters", () => {
    const nasty = "a\x1b[2Jb\x9b31mc\x7fd\u202ee\u2066f\ud800g\th 🐍";
    const r = recorder([nasty]);
    r.record(state(0), report(0, { error: nasty, log: { lines: [nasty], truncated: false } }));
    const trace = decode(r.finish(END));
    const clean = "a?[2Jb?31mc?d?e?f?g\th 🐍";
    expect(trace.load.log).toEqual([clean]);
    expect(trace.full[0]?.log).toEqual([clean]);
    expect(trace.full[0]?.error).toBe(clean);
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
            spawnGrace: 0,
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
            spawnGrace: 0,
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
