import { describe, expect, it } from "vitest";
import { hashWorld } from "./hash.ts";
import {
  BitModel,
  F64Model,
  IntModel,
  RangeDecoder,
  RangeEncoder,
  StringModel,
  TreeModel,
  UintModel,
} from "./rangecoder.ts";
import {
  CHUNK_TICKS,
  decodeReplayChunk,
  encodeReplayChunk,
  REPLAY_VERSION,
  type ReplayChunk,
  ReplayDesyncError,
  ReplayPlayer,
  ReplayRecorder,
  replayChunkInfo,
  replayChunkVersion,
} from "./replay.ts";
import { createRng } from "./rng.ts";
import { quantizeTurn, TURN_STEPS } from "./step.ts";
import { actionsFor, farm, type Policy, wander } from "./testing/policies.ts";
import { place } from "./testing/setup.ts";
import type { Fault, World } from "./types.ts";
import { cloneWorld, createWorld } from "./world.ts";

interface Recording {
  chunks: Uint8Array[];
  /** Frame hash by tick: every 10 ticks and around the chunk boundaries. */
  hashes: Map<number, number>;
  final: World;
}

/**
 * A room as the arena would run it: `snakes` bots, the dead respawned under new ids, a third of
 * them farmers, the rest random walkers, and the odd sandbox fault.
 */
function record(
  seed: number,
  ticks: number,
  snakes = 15,
  options: {
    stopAt?: number;
    resume?: (r: ReplayRecorder, onChunk: (bytes: Uint8Array) => void) => ReplayRecorder;
  } = {},
): Recording {
  const world = createWorld({ seed });
  const chunks: Uint8Array[] = [];
  const onChunk = (bytes: Uint8Array) => chunks.push(bytes);
  let recorder = new ReplayRecorder(world, { onChunk });
  const policies: Record<string, Policy> = {};
  const faultRng = createRng(seed + 1);
  let lives = 0;
  const fill = () => {
    while (recorder.world.snakes.length < snakes) {
      const id = `s${lives++}`;
      policies[id] = lives % 3 === 0 ? farm : wander(seed * 1000 + lives);
      recorder.spawn({ id, author: `author${lives % 6}` });
    }
  };
  const hashes = new Map<number, number>();
  fill();
  hashes.set(0, hashWorld(world));
  for (let t = 1; t <= ticks; t++) {
    const w = recorder.world;
    const faults: Record<string, Fault> = {};
    if (faultRng.next() < 0.01 && w.snakes.length > 0) {
      const victim = w.snakes[faultRng.int(w.snakes.length)];
      if (victim) faults[victim.id] = faultRng.next() < 0.5 ? "timeout" : "error";
    }
    recorder.step(actionsFor(w, policies), faults);
    fill();
    const inChunk = t % CHUNK_TICKS;
    if (t % 10 === 0 || inChunk <= 2 || inChunk >= CHUNK_TICKS - 2) {
      hashes.set(t, hashWorld(recorder.world));
    }
    if (t === options.stopAt && options.resume) recorder = options.resume(recorder, onChunk);
  }
  recorder.flush();
  return { chunks, hashes, final: recorder.world };
}

const long = record(3, 3000);

describe("range coder", () => {
  it("round-trips bits, integers, floats and strings", () => {
    const rng = createRng(1);
    const floats = [0, -0, 1, -1, Math.PI, 1e-300, -1e300, Infinity, -Infinity, 5e-324];
    for (let i = 0; i < 500; i++) floats.push((rng.next() - 0.5) * 10 ** rng.int(20));
    const uints = [0, 1, 127, 128, 2 ** 32, Number.MAX_SAFE_INTEGER];
    for (let i = 0; i < 500; i++) uints.push(rng.int(2 ** rng.int(40)));
    const ints = uints.filter((u) => u > 0 && u < 2 ** 52);
    const strings = ["", "alice", "snake-é-🐍", "x".repeat(300)];
    const bits = Array.from({ length: 2000 }, () => rng.next() < 0.9);

    const m = () => ({
      bit: new BitModel(2),
      tree: new TreeModel(9),
      uint: new UintModel(),
      int: new IntModel(),
      f64: new F64Model(),
      str: new StringModel(),
    });
    const w = m();
    const e = new RangeEncoder();
    for (let i = 0; i < bits.length; i++) w.bit.write(e, bits[i] === true, i % 2);
    for (let v = 0; v < 512; v++) w.tree.write(e, v);
    for (const u of uints) w.uint.write(e, u);
    for (const u of ints) w.int.write(e, -u);
    for (let i = 0; i < floats.length; i++) w.f64.write(e, floats[i] as number, floats[i - 1]);
    w.f64.write(e, Number.NaN);
    for (const s of strings) w.str.write(e, s);
    const bytes = e.finish();
    // 90/10 bits cost about half a bit each.
    expect(bytes.length).toBeLessThan(10_000);

    const r = m();
    const d = new RangeDecoder(bytes);
    expect(bits.map((_, i) => r.bit.read(d, i % 2))).toEqual(bits);
    for (let v = 0; v < 512; v++) expect(r.tree.read(d)).toBe(v);
    for (const u of uints) expect(r.uint.read(d)).toBe(u);
    for (const u of ints) expect(r.int.read(d)).toBe(-u);
    for (let i = 0; i < floats.length; i++) {
      expect(Object.is(r.f64.read(d, floats[i - 1]), floats[i])).toBe(true);
    }
    expect(r.f64.read(d)).toBeNaN();
    for (const s of strings) expect(r.str.read(d)).toBe(s);
  });

  it("rejects what it can't code exactly", () => {
    const e = new RangeEncoder();
    expect(() => new UintModel().write(e, -1)).toThrow(RangeError);
    expect(() => new UintModel().write(e, 1.5)).toThrow(RangeError);
  });
});

describe("quantizeTurn", () => {
  it("rounds to 1/TURN_STEPS, clamps, and maps junk to 0", () => {
    expect(quantizeTurn(1)).toBe(TURN_STEPS);
    expect(quantizeTurn(-7)).toBe(-TURN_STEPS);
    expect(quantizeTurn(0.5)).toBe(TURN_STEPS / 2);
    expect(quantizeTurn(0.3)).toBe(Math.round(0.3 * TURN_STEPS));
    expect(Object.is(quantizeTurn(-0.001), 0)).toBe(true);
    for (const junk of [Number.NaN, undefined, null, "x", {}]) expect(quantizeTurn(junk)).toBe(0);
  });
});

describe("replay", () => {
  it("fits 3000 ticks × 15 snakes in under 100 KB", () => {
    const total = long.chunks.reduce((n, c) => n + c.length, 0);
    expect(total).toBeLessThan(100_000);
    expect(long.chunks.map(replayChunkInfo)).toEqual([
      { startTick: 0, endTick: CHUNK_TICKS },
      { startTick: CHUNK_TICKS, endTick: 2 * CHUNK_TICKS },
      { startTick: 2 * CHUNK_TICKS, endTick: 3000 },
    ]);
  });

  it("plays back bit-identically, hash checked every 10 ticks", () => {
    const player = new ReplayPlayer(long.chunks);
    expect([player.startTick, player.endTick]).toEqual([0, 3000]);
    expect(hashWorld(player.world)).toBe(long.hashes.get(0));
    let deaths = 0;
    while (player.tick < player.endTick) {
      const world = player.next();
      deaths += world.deaths.length;
      const expected = long.hashes.get(world.tick);
      if (expected !== undefined) expect(hashWorld(world)).toBe(expected);
    }
    expect(deaths).toBeGreaterThan(10);
    expect(player.world).toEqual(long.final);
    expect(() => player.next()).toThrow(RangeError);
  });

  it("seeks to any tick, backwards and across chunks", () => {
    const player = new ReplayPlayer(long.chunks);
    const rng = createRng(9);
    const targets = [3000, 0, 1200, 1199, 2400, 2401, 10, 2990, 1500, 1210];
    for (let i = 0; i < 10; i++) targets.push(rng.int(301) * 10);
    for (const t of targets) {
      expect(player.seek(t).tick).toBe(t);
      expect(hashWorld(player.world)).toBe(long.hashes.get(t));
    }
    expect(() => player.seek(3001)).toThrow(RangeError);
    expect(() => player.seek(-1)).toThrow(RangeError);
    expect(() => player.seek(1.5)).toThrow(RangeError);
  });

  it("exposes the inputs of the current frame", () => {
    const player = new ReplayPlayer(long.chunks);
    const world = player.seek(1234);
    const actions = player.actions();
    expect(Object.keys(actions ?? {})).toEqual(world.snakes.map((s) => s.id));
    expect(player.inputs()?.turns).toHaveLength(world.snakes.length);
    player.seek(3000);
    expect(player.inputs()).toBeNull();
    expect(player.actions()).toBeNull();
  });

  it("encodes and decodes chunks losslessly", () => {
    for (const bytes of long.chunks) {
      const chunk = decodeReplayChunk(bytes);
      expect(encodeReplayChunk(chunk)).toEqual(bytes);
      expect(decodeReplayChunk(encodeReplayChunk(chunk))).toEqual(chunk);
    }
  });

  it("emits the same chunks when recording resumes from persisted state", () => {
    const resumed = record(3, 3000, 15, {
      stopAt: 1777,
      resume: (r, onChunk) => {
        // What a Durable Object would store and load: the world as JSON, the open chunk encoded.
        const world = JSON.parse(JSON.stringify(r.world)) as World;
        const pending = encodeReplayChunk(r.pending as ReplayChunk);
        expect(pending.length).toBeLessThan(50_000);
        return new ReplayRecorder(world, { onChunk, pending: decodeReplayChunk(pending) });
      },
    });
    expect(resumed.chunks).toEqual(long.chunks);
  });

  it("detects a replay that no longer matches the engine", () => {
    const chunk = decodeReplayChunk(long.chunks[0] as Uint8Array);
    const t = chunk.ticks[150];
    if (!t) throw new Error("short chunk");
    t.turns[0] = t.turns[0] === 0 ? 64 : 0;
    const tampered = [encodeReplayChunk(chunk), ...long.chunks.slice(1)];
    const player = new ReplayPlayer(tampered);
    expect(() => player.seek(400)).toThrow(ReplayDesyncError);
    // Without verification it plays on, and resyncs at the next chunk's snapshot.
    const lax = new ReplayPlayer(tampered, { verify: false });
    lax.seek(1300);
    expect(hashWorld(lax.world)).toBe(long.hashes.get(1300));
  });

  it("plays a world from before #101 (no remainsPerSegment) back on the old remains layout", () => {
    const world = createWorld({ seed: 9 });
    delete (world.config as { remainsPerSegment?: number }).remainsPerSegment;
    const chunks: Uint8Array[] = [];
    const recorder = new ReplayRecorder(world, { onChunk: (bytes) => chunks.push(bytes) });
    for (const id of ["a", "b", "c"]) recorder.spawn({ id, author: id });
    // A newborn dies: the old layout drops 1 pellet of 10 (the new one 3), then the rest fly
    // straight into the wall.
    recorder.step({}, { a: "error" });
    for (let t = 1; t < 250; t++) recorder.step({});
    recorder.flush();

    const player = new ReplayPlayer(chunks);
    expect(Object.keys(player.world.config)).not.toContain("remainsPerSegment");
    player.seek(1);
    expect(player.world.food.filter((f) => f.kind === "remains")).toEqual([
      expect.objectContaining({ value: expect.closeTo(10, 1) }),
    ]);
    // Hash checked on the way: no desync.
    player.seek(250);
    expect(player.world).toEqual(recorder.world);
    expect(recorder.world.snakes).toEqual([]);
  });

  it("rejects chunks that are not consecutive or not replays", () => {
    expect(() => new ReplayPlayer([long.chunks[0], long.chunks[2]] as Uint8Array[])).toThrow(
      /consecutive/,
    );
    expect(() => new ReplayPlayer([new Uint8Array([1, 2, 3, 4, 5])])).toThrow(/not a replay/);
    expect(() => new ReplayPlayer([])).toThrow(/empty/);
  });

  it("snapshots exactly, including a world mid-run", () => {
    const world = cloneWorld(long.final);
    const bytes = encodeReplayChunk({
      snapshot: world,
      snapshotHash: hashWorld(world),
      spawns: [],
      ticks: [],
    });
    expect(decodeReplayChunk(bytes).snapshot).toEqual(world);
  });

  it("records snakes spawned between a flush and the next step", () => {
    const world = createWorld({ seed: 1 });
    const chunks: Uint8Array[] = [];
    const recorder = new ReplayRecorder(world, { onChunk: (b) => chunks.push(b) });
    const hashes: number[] = [];
    const steps = (n: number) => {
      for (let i = 0; i < n; i++) {
        recorder.step({ a: { turn: 0.25 }, b: { turn: -0.5, boost: true } });
        hashes[world.tick] = hashWorld(world);
      }
    };
    recorder.spawn({ id: "a", author: "alice" });
    hashes[0] = hashWorld(world);
    steps(5);
    recorder.flush();
    recorder.spawn({ id: "b", author: "bob" });
    hashes[5] = hashWorld(world);
    steps(5);
    recorder.flush();
    recorder.flush(); // nothing new: no empty chunk
    expect(chunks.map(replayChunkInfo)).toEqual([
      { startTick: 0, endTick: 5 },
      { startTick: 5, endTick: 10 },
    ]);

    const player = new ReplayPlayer(chunks);
    expect(hashWorld(player.world)).toBe(hashes[0]);
    while (player.tick < player.endTick) expect(hashWorld(player.next())).toBe(hashes[player.tick]);
    for (const t of [5, 3, 10, 0, 5]) expect(hashWorld(player.seek(t))).toBe(hashes[t]);
  });

  it("stays in sync with flushes and spawns at random points", () => {
    for (let seed = 1; seed <= 4; seed++) {
      const rng = createRng(seed);
      const world = createWorld({ seed });
      const chunks: Uint8Array[] = [];
      const recorder = new ReplayRecorder(world, {
        onChunk: (b) => chunks.push(b),
        chunkTicks: 1 + rng.int(40),
        hashEvery: 1 + rng.int(10),
      });
      const hashes: number[] = [];
      let lives = 0;
      for (let t = 0; t < 150; t++) {
        if (rng.next() < 0.05) recorder.flush();
        while (world.snakes.length < 4 || rng.next() < 0.02) {
          recorder.spawn({ id: `s${lives++}`, author: "x" });
        }
        hashes[world.tick] = hashWorld(world);
        const actions = Object.fromEntries(
          world.snakes.map((s) => [s.id, { turn: rng.range(-1.2, 1.2), boost: rng.next() < 0.1 }]),
        );
        recorder.step(actions);
      }
      recorder.flush();
      hashes[world.tick] = hashWorld(world);

      const player = new ReplayPlayer(chunks);
      while (player.tick < player.endTick) {
        expect(hashWorld(player.next())).toBe(hashes[player.tick]);
      }
      for (let k = 0; k < 20; k++) {
        const t = rng.int(151);
        expect(hashWorld(player.seek(t))).toBe(hashes[t]);
      }
    }
  });
});

describe("hostile input", () => {
  const world = createWorld({ seed: 1 });
  const chunk = (snapshot: World): Uint8Array =>
    encodeReplayChunk({ snapshot, snapshotHash: 0, spawns: [], ticks: [] });

  it("tells the format version, and refuses chunks of another one", () => {
    const bytes = chunk(world);
    expect(replayChunkVersion(bytes)).toBe(REPLAY_VERSION);
    const v1 = bytes.slice();
    v1[3] = 1;
    expect(replayChunkVersion(v1)).toBe(1);
    expect(() => decodeReplayChunk(v1)).toThrow(/unsupported version/);
    expect(replayChunkVersion(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(replayChunkVersion(bytes.subarray(0, 3))).toBeNull();
  });

  it("refuses to decode more values than the input can hold", () => {
    const d = new RangeDecoder(new Uint8Array(100));
    const bit = new BitModel();
    expect(() => {
      for (let i = 0; i < 1_000_000; i++) bit.read(d);
    }).toThrow(/truncated/);
  });

  it("rejects an absurd segment count before laying it out", () => {
    const w = cloneWorld(world);
    const s = place(w, { id: "a", x: 0, y: 0, angle: 0 });
    s.segments = { length: 20_000_000 } as unknown as typeof s.segments;
    const t0 = Date.now();
    expect(() => decodeReplayChunk(chunk(w))).toThrow(/segment count/);
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it("rejects configs that would allocate or loop absurdly", () => {
    for (const config of [
      { gridCellSize: 1e-6 },
      { arenaHalfSize: Number.POSITIVE_INFINITY },
      { minSize: 0 },
      { baseSegments: 1e9 },
      { spawnAttempts: 1e12 },
    ]) {
      const w = cloneWorld(world);
      Object.assign(w.config, config);
      expect(() => decodeReplayChunk(chunk(w))).toThrow(/implausible config/);
    }
  });
});
