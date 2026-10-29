import {
  createWorld,
  decodeReplayChunk,
  encodeReplayChunk,
  quantizeTurn,
  ReplayRecorder,
  TURN_STEPS,
} from "@zerosnake/engine";
import { describe, expect, it } from "vitest";
import { KEYFRAME_INTERVAL, ReplaySource } from "./ReplaySource";

interface Recorded {
  chunks: Uint8Array[];
  /** Per tick: every living snake's id and head, as the live run had them. */
  frames: { id: string; x: number; y: number; score: number }[][];
  /** Turn each snake was given on each tick. */
  turns: Map<string, number>[];
  deaths: { id: string; tick: number; cause: string }[];
  spawned: string[];
}

/**
 * A small arena with steering bots that respawn, cut into short chunks so playback has to
 * cross chunk boundaries and keyframes.
 */
function record(ticks = 420, chunkTicks = 150): Recorded {
  const world = createWorld({ seed: 7, config: { arenaHalfSize: 22 } });
  const chunks: Uint8Array[] = [];
  const recorder = new ReplayRecorder(world, { chunkTicks, onChunk: (b) => chunks.push(b) });
  const out: Recorded = { chunks, frames: [], turns: [], deaths: [], spawned: [] };
  const next = new Map<string, number>();
  const spawn = (bot: string) => {
    const n = (next.get(bot) ?? 0) + 1;
    next.set(bot, n);
    const id = `${bot}#${n}`;
    recorder.spawn({ id, author: bot });
    out.spawned.push(id);
  };
  for (const bot of ["a", "b", "c", "d"]) spawn(bot);
  const respawn: { bot: string; at: number }[] = [];

  const snap = () => {
    out.frames[world.tick] = world.snakes.map((s) => ({
      id: s.id,
      x: s.head.x,
      y: s.head.y,
      score: s.score,
    }));
  };
  snap();
  while (world.tick < ticks) {
    const turns = new Map<string, number>();
    const actions: Record<string, { turn: number; boost: boolean }> = {};
    for (const s of world.snakes) {
      const turn = Math.sin(world.tick / 13 + s.id.charCodeAt(0));
      turns.set(s.id, quantizeTurn(turn) / TURN_STEPS);
      actions[s.id] = { turn, boost: world.tick % 40 < 5 };
    }
    out.turns[world.tick] = turns;
    recorder.step(actions);
    for (const d of world.deaths) {
      out.deaths.push({ id: d.id, tick: d.tick, cause: d.cause });
      respawn.push({ bot: d.id.split("#")[0] as string, at: world.tick + 10 });
    }
    for (const r of respawn.filter((r) => r.at === world.tick)) spawn(r.bot);
    snap();
  }
  recorder.flush();
  return out;
}

const rec = record();

it("shows a house bot the room retired as retired, a deployed bot's error as error", () => {
  const world = createWorld({ seed: 3, config: { arenaHalfSize: 30 } });
  const chunks: Uint8Array[] = [];
  const recorder = new ReplayRecorder(world, { chunkTicks: 50, onChunk: (b) => chunks.push(b) });
  recorder.spawn({ id: "house-medium-0-0", author: "house:medium#2" });
  recorder.spawn({ id: "life-1", author: "EwHtzo4BxLbOftvbTBy6BjWVEorxGVKa" });
  recorder.spawn({ id: "life-2", author: "q3Zr8LkP0aWm5TnYx2BcVd7GhJ4sEf9u" });
  recorder.step({}, { "house-medium-0-0": "error", "life-1": "error" });
  for (let t = 1; t < 5; t++) recorder.step({});
  recorder.flush();
  const replay = new ReplaySource(chunks);
  expect(replay.life("house-medium-0-0")?.death?.cause).toBe("retired");
  expect(replay.life("life-1")?.death?.cause).toBe("error");
  expect(replay.life("life-2")?.death).toBeUndefined();
});

describe("ReplaySource", () => {
  const source = new ReplaySource(rec.chunks, { title: "test" });

  it("covers the whole recording", () => {
    expect(rec.chunks.length).toBeGreaterThan(2);
    expect(source.firstTick).toBe(0);
    expect(source.lastTick).toBe(rec.frames.length - 1);
    expect(source.endTick).toBe(source.lastTick);
    expect(source.desync).toBeUndefined();
    expect(source.info).toMatchObject({ title: "test", arenaHalfSize: 22, tps: 10 });
    expect(source.snapshot(-1)).toBeUndefined();
    expect(source.snapshot(source.lastTick + 1)).toBeUndefined();
    expect(source.snapshot(1.5)).toBeUndefined();
  });

  it("finds every life and death", () => {
    expect(rec.deaths.length).toBeGreaterThan(3);
    expect(source.lives().map((l) => l.id)).toEqual(rec.spawned);
    for (const d of rec.deaths) {
      expect(source.life(d.id)?.death).toMatchObject({ tick: d.tick, cause: d.cause });
      expect(source.snapshot(d.tick)?.deaths).toContain(d.id);
      expect(source.snapshot(d.tick)?.snakes.map((s) => s.id)).not.toContain(d.id);
    }
  });

  const expectTick = (tick: number) => {
    const snap = source.snapshot(tick);
    const want = rec.frames[tick];
    expect(snap?.tick).toBe(tick);
    expect(
      snap?.frame.snakes.map((s) => ({ id: s.id, x: s.segments[0]?.x, y: s.segments[0]?.y })),
    ).toEqual(want?.map(({ id, x, y }) => ({ id, x, y })));
    expect(snap?.snakes.map((s) => s.score)).toEqual(want?.map((s) => s.score));
  };

  it("rebuilds every tick played forward", () => {
    for (let t = source.firstTick; t <= source.lastTick; t++) expectTick(t);
  });

  it("rebuilds ticks in any order, across keyframes and chunks", () => {
    const order = [rec.frames.length - 1, 0, 151, 150, 149, KEYFRAME_INTERVAL - 1, 299, 300, 7];
    for (let i = 0; i < 40; i++) order.push((i * 7919) % rec.frames.length);
    for (const t of order) expectTick(t);
  });

  it("reports the recorded action as each tick's trace", () => {
    for (const t of [0, 1, 150, 299, 400]) {
      for (const [id, turn] of rec.turns[t] ?? []) {
        expect(source.trace(id, t)?.action?.turn).toBeCloseTo(turn, 12);
        expect(source.snapshot(t)?.snakes.find((s) => s.id === id)?.action?.turn).toBeCloseTo(
          turn,
          12,
        );
      }
    }
    expect(source.trace("nobody", 0)).toBeUndefined();
    // The last frame has no step after it.
    expect(source.trace(rec.frames.at(-1)?.[0]?.id ?? "", source.lastTick)).toBeUndefined();
  });

  it("adds a life's recorded logs and cost to its trace", () => {
    const own = new ReplaySource(rec.chunks);
    const id = rec.frames[10]?.[0]?.id as string;
    const tick = (t: number) => ({
      tick: t,
      lifeTick: t,
      turn: 0,
      boost: false,
      outcome: "ok" as const,
      work: 5,
      ops: t,
      log: [`at ${t}`],
      seen: {
        x: 0,
        y: 0,
        angle: 0,
        length: 1,
        wall: 1,
        snakes: 0,
        food: 0,
        nearest: null,
        foodDist: null,
      },
    });
    own.setTrace(id, [tick(10), { ...tick(11), logCut: true }]);
    expect(own.trace(id, 10)).toMatchObject({ logs: ["at 10"], ops: 10 });
    expect(own.trace(id, 10)?.action?.turn).toBeCloseTo(rec.turns[10]?.get(id) ?? NaN, 12);
    expect(own.trace(id, 11)).toMatchObject({ logs: ["at 11"], logTruncated: true });
    // Downsampled away: the recorded action only.
    expect(own.trace(id, 12)?.logs).toBeUndefined();
    expect(source.trace(id, 10)?.logs).toBeUndefined();
  });

  it("labels lives with the caller's names and colours", () => {
    const labelled = new ReplaySource(rec.chunks, {
      label: (s, i) => ({ bot: `bot ${s.author}`, author: `@${s.author}`, color: `#00000${i}` }),
    });
    expect(labelled.life("b#1")).toMatchObject({ bot: "bot b", author: "@b", color: "#000001" });
    expect(labelled.snapshot(0)?.frame.snakes[0]?.skin?.color).toBe("#000000");
  });

  it("still plays a replay whose hashes don't match, and says so", () => {
    const chunk = decodeReplayChunk(rec.chunks[1] as Uint8Array);
    const hashed = chunk.ticks.find((t) => t.hash !== null);
    if (!hashed || hashed.hash === null) throw new Error("no hashed tick");
    hashed.hash ^= 1;
    const chunks = [...rec.chunks];
    chunks[1] = encodeReplayChunk(chunk);
    const tampered = new ReplaySource(chunks);
    expect(tampered.desync?.name).toBe("ReplayDesyncError");
    expect(tampered.lives().map((l) => l.id)).toEqual(rec.spawned);
    expect(tampered.snapshot(200)?.frame.snakes.length).toBe(rec.frames[200]?.length);
  });
});
