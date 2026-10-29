import { type EngineConfig, TICK_RATE } from "./config.ts";
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
import { quantizeTurn, step, TURN_STEPS } from "./step.ts";
import type {
  Action,
  ActionMap,
  Death,
  DeathCause,
  Fault,
  FaultMap,
  Food,
  FoodKind,
  Snake,
  Vec2,
  World,
} from "./types.ts";
import { cloneWorld, layoutSegments, type SpawnOptions, spawnSnake } from "./world.ts";

/**
 * Room replays (SPEC §7): a world snapshot plus every input after it, in chunks of about two
 * minutes, each one self-contained and binary-encoded with an adaptive range coder.
 *
 * A **frame** is the world between two steps, after that tick's spawns: what the bots see and
 * what the next `step` gets. A chunk holds the world it was opened on (a snapshot: the previous
 * chunk's last frame, or the room's starting world), the snakes spawned before its first step,
 * and for each tick the inputs that lead to the next frame: every living snake's action, sandbox
 * faults, then the snakes spawned after the step. The seed is part of the snapshot (as the PRNG
 * state). Every change to the world between steps must go through the recorder.
 *
 * Playback re-runs the engine, so it is exact only on the same engine version; the recorder
 * stores a world hash every `hashEvery` ticks and the player checks it, so drift is caught
 * instead of shown.
 *
 *   const recorder = new ReplayRecorder(world, { onChunk: (bytes) => r2.put(key, bytes) });
 *   recorder.spawn({ id, author });            // instead of spawnSnake
 *   recorder.step(actions, faults);            // instead of step
 *   recorder.flush();                          // on shutdown: emit the unfinished chunk
 *
 *   const player = new ReplayPlayer(chunks);   // all chunks of a room, in order
 *   player.seek(1234);                         // the frame at tick 1234
 *   player.next();                             // one tick forward
 */

/** Two minutes of game time. */
export const CHUNK_TICKS = 120 * TICK_RATE;
/** Ticks between recorded world hashes. */
export const HASH_EVERY = 100;
/**
 * The chunk format: the fourth byte of every chunk. Version 2 is the square arena (#76); version 1
 * chunks were recorded on the round one, which this engine can't play back, so they are refused
 * rather than replayed wrong (see {@link replayChunkVersion}).
 */
export const REPLAY_VERSION = 2;
const MAGIC = [0x5a, 0x53, 0x52, REPLAY_VERSION]; // "ZSR", version
/**
 * Decoding limits. The range decoder already refuses to decode more values than its input could
 * hold (see `RangeDecoder`); these cover what a single small number can blow up into (body
 * layout, the spatial grids `step` allocates from the config). Far above anything a real room
 * produces.
 */
const MAX_SEGMENTS = 100_000;
const MAX_GRID_CELLS_PER_SIDE = 1024;
const MAX_LOOP_CONFIG = 100_000;

/** The inputs from one frame to the next. Plain data. */
export interface ReplayTick {
  /** Quantised turn (`quantizeTurn`) of each living snake, in `world.snakes` order. */
  turns: number[];
  /** Whether each snake asked to boost, same order. */
  boosts: boolean[];
  /** Sandbox faults, by index in the same order. */
  faults: { index: number; fault: Fault }[];
  /** Snakes spawned after the step, in order. */
  spawns: SpawnOptions[];
  /** `hashWorld` of the frame this tick leads to, when recorded. */
  hash: number | null;
}

/** One self-contained piece of a replay. Plain data, so a recorder can persist its open chunk. */
export interface ReplayChunk {
  /** The world the chunk was opened on; `snapshot.tick` is its first tick. */
  snapshot: World;
  snapshotHash: number;
  /** Snakes spawned on the snapshot before the first step; with them it is the first frame. */
  spawns: SpawnOptions[];
  /** Inputs for ticks `snapshot.tick` → `snapshot.tick + ticks.length`. */
  ticks: ReplayTick[];
}

export interface ReplayChunkInfo {
  /** Tick of the first frame. */
  startTick: number;
  /** Tick of the last frame (the frame the next chunk starts from). */
  endTick: number;
}

// --- Encoding ----------------------------------------------------------------------------------

const CAUSES: readonly DeathCause[] = ["collision", "wall", "timeout", "error", "retired"];
const KINDS: readonly FoodKind[] = ["ambient", "boost", "remains"];

/** Every model of one chunk. Encoder and decoder build a fresh set and use them in step. */
class Models {
  count = new UintModel();
  tick = new UintModel();
  small = new UintModel();
  f64 = new F64Model();
  trail = new F64Model();
  foodXY = new F64Model();
  foodValue = new F64Model();
  foodId = new IntModel();
  kind = new TreeModel(2);
  cause = new TreeModel(3);
  flag = new BitModel(8);
  str = new StringModel();
  strIndex = new UintModel();
  hash = new TreeModel(8);
  // Ticks.
  sameCount = new BitModel();
  sameTurn = new BitModel(2);
  turn = new TreeModel(9);
  boost = new BitModel(2);
  faults = new UintModel();
  spawns = new UintModel();
  /** Strings seen so far in this chunk (ids, authors, config keys). */
  strings: string[] = [];
  stringIds = new Map<string, number>();
}

const FLAG_BOOSTING = 0;
const FLAG_HAS_HASH = 1;
const FLAG_FAULT = 2;

class Writer {
  readonly e = new RangeEncoder();
  readonly m = new Models();

  uint(v: number): void {
    this.m.small.write(this.e, v);
  }

  f64(v: number, ref = 0): void {
    this.m.f64.write(this.e, v, ref);
  }

  u32(v: number): void {
    for (let k = 24; k >= 0; k -= 8) this.m.hash.write(this.e, (v >>> k) & 0xff);
  }

  /** A string, or null, through the chunk's string table. */
  str(s: string | null): void {
    const known = s === null ? -1 : this.m.stringIds.get(s);
    if (known !== undefined) {
      this.m.strIndex.write(this.e, known + 1);
      return;
    }
    const str = s as string;
    this.m.strIndex.write(this.e, this.m.strings.length + 1);
    this.m.str.write(this.e, str);
    this.m.stringIds.set(str, this.m.strings.length);
    this.m.strings.push(str);
  }
}

class Reader {
  readonly d: RangeDecoder;
  readonly m = new Models();

  constructor(bytes: Uint8Array) {
    for (let i = 0; i < MAGIC.length; i++) {
      if (bytes[i] !== MAGIC[i]) throw new Error("not a replay chunk (or an unsupported version)");
    }
    this.d = new RangeDecoder(bytes, MAGIC.length);
  }

  uint(): number {
    return this.m.small.read(this.d);
  }

  f64(ref = 0): number {
    return this.m.f64.read(this.d, ref);
  }

  u32(): number {
    let v = 0;
    for (let k = 0; k < 4; k++) v = v * 256 + this.m.hash.read(this.d);
    return v;
  }

  str(): string | null {
    const i = this.m.strIndex.read(this.d);
    if (i === 0) return null;
    if (i <= this.m.strings.length) return this.m.strings[i - 1] as string;
    const s = this.m.str.read(this.d);
    this.m.strings.push(s);
    return s;
  }

  string(): string {
    const s = this.str();
    if (s === null) throw new Error("replay chunk: unexpected null string");
    return s;
  }
}

/** Binary form of a chunk. */
export function encodeReplayChunk(chunk: ReplayChunk): Uint8Array {
  const w = new Writer();
  const { e, m } = w;
  m.tick.write(e, chunk.snapshot.tick);
  m.count.write(e, chunk.ticks.length);
  w.u32(chunk.snapshotHash);
  writeWorld(w, chunk.snapshot);
  writeSpawns(w, chunk.spawns);

  let prevTurns: number[] = [];
  let prevSame: number[] = [];
  let prevBoosts: boolean[] = [];
  for (const t of chunk.ticks) {
    const n = t.turns.length;
    if (t.boosts.length !== n) throw new Error("replay tick: turns and boosts differ in length");
    m.sameCount.write(e, n === prevTurns.length);
    if (n !== prevTurns.length) m.count.write(e, n);
    const same: number[] = new Array(n);
    for (let j = 0; j < n; j++) {
      const q = t.turns[j] as number;
      if (q !== quantizeTurn(q / TURN_STEPS)) throw new RangeError(`not a quantised turn: ${q}`);
      const s = q === (prevTurns[j] ?? 0) ? 1 : 0;
      same[j] = s;
      m.sameTurn.write(e, s === 1, prevSame[j] ?? 1);
      if (s === 0) m.turn.write(e, q + TURN_STEPS);
      const boost = t.boosts[j] === true;
      m.boost.write(e, boost, prevBoosts[j] ? 1 : 0);
    }
    prevTurns = t.turns;
    prevSame = same;
    prevBoosts = t.boosts;

    m.faults.write(e, t.faults.length);
    for (const f of t.faults) {
      w.uint(f.index);
      m.flag.write(e, f.fault === "error", FLAG_FAULT);
    }
    writeSpawns(w, t.spawns);
    m.flag.write(e, t.hash !== null, FLAG_HAS_HASH);
    if (t.hash !== null) w.u32(t.hash);
  }
  const body = e.finish();
  const out = new Uint8Array(MAGIC.length + body.length);
  out.set(MAGIC);
  out.set(body, MAGIC.length);
  return out;
}

/** Inverse of {@link encodeReplayChunk}. Throws if the snapshot doesn't match its hash. */
export function decodeReplayChunk(bytes: Uint8Array): ReplayChunk {
  const r = new Reader(bytes);
  const { d, m } = r;
  const startTick = m.tick.read(d);
  const count = m.count.read(d);
  const snapshotHash = r.u32();
  const snapshot = readWorld(r, startTick);
  if (hashWorld(snapshot) !== snapshotHash) throw new Error("replay chunk: snapshot hash mismatch");
  const firstSpawns = readSpawns(r);

  const ticks: ReplayTick[] = [];
  let prevTurns: number[] = [];
  let prevSame: number[] = [];
  let prevBoosts: boolean[] = [];
  for (let i = 0; i < count; i++) {
    const n = m.sameCount.read(d) ? prevTurns.length : m.count.read(d);
    const turns: number[] = new Array(n);
    const boosts: boolean[] = new Array(n);
    const same: number[] = new Array(n);
    for (let j = 0; j < n; j++) {
      const s = m.sameTurn.read(d, prevSame[j] ?? 1);
      same[j] = s ? 1 : 0;
      turns[j] = s ? (prevTurns[j] ?? 0) : m.turn.read(d) - TURN_STEPS;
      boosts[j] = m.boost.read(d, prevBoosts[j] ? 1 : 0);
    }
    prevTurns = turns;
    prevSame = same;
    prevBoosts = boosts;

    const faults: ReplayTick["faults"] = [];
    for (let k = m.faults.read(d); k > 0; k--) {
      const index = r.uint();
      faults.push({ index, fault: m.flag.read(d, FLAG_FAULT) ? "error" : "timeout" });
    }
    const spawns = readSpawns(r);
    const hash = m.flag.read(d, FLAG_HAS_HASH) ? r.u32() : null;
    ticks.push({ turns, boosts, faults, spawns, hash });
  }
  return { snapshot, snapshotHash, spawns: firstSpawns, ticks };
}

/**
 * The format version an encoded chunk was written in, or null if it isn't a replay chunk at all.
 * Only {@link REPLAY_VERSION} decodes; anything else was recorded by another engine.
 */
export function replayChunkVersion(bytes: Uint8Array): number | null {
  for (let i = 0; i < MAGIC.length - 1; i++) if (bytes[i] !== MAGIC[i]) return null;
  return bytes.length >= MAGIC.length ? (bytes[MAGIC.length - 1] as number) : null;
}

/** First and last tick of an encoded chunk, without decoding the rest. */
export function replayChunkInfo(bytes: Uint8Array): ReplayChunkInfo {
  const r = new Reader(bytes);
  const startTick = r.m.tick.read(r.d);
  return { startTick, endTick: startTick + r.m.count.read(r.d) };
}

function writeSpawns(w: Writer, spawns: readonly SpawnOptions[]): void {
  w.m.spawns.write(w.e, spawns.length);
  for (const s of spawns) {
    w.str(s.id);
    w.str(s.author);
  }
}

function readSpawns(r: Reader): SpawnOptions[] {
  const spawns: SpawnOptions[] = [];
  for (let k = r.m.spawns.read(r.d); k > 0; k--) {
    const id = r.string();
    spawns.push({ id, author: r.string() });
  }
  return spawns;
}

function writeWorld(w: Writer, world: World): void {
  const { e, m } = w;
  const config = Object.entries(world.config);
  m.count.write(e, config.length);
  for (const [key, value] of config) {
    w.str(key);
    w.f64(value);
  }
  for (const v of world.rng) w.f64(v);
  w.uint(world.nextFoodId);

  m.count.write(e, world.deaths.length);
  for (const death of world.deaths) {
    w.str(death.id);
    w.str(death.author);
    m.cause.write(e, CAUSES.indexOf(death.cause));
    w.str(death.killerId);
    w.str(death.killerAuthor);
    m.tick.write(e, death.tick);
    w.uint(death.lifeTicks);
    w.f64(death.mass);
    w.f64(death.maxMass);
    w.uint(death.kills);
    w.f64(death.score);
  }

  m.count.write(e, world.snakes.length);
  for (const s of world.snakes) {
    w.str(s.id);
    w.str(s.author);
    w.f64(s.seed);
    w.f64(s.angle);
    w.f64(s.speed);
    m.flag.write(e, s.boosting, FLAG_BOOSTING);
    w.f64(s.mass);
    w.f64(s.size);
    // Segments are re-laid from the trail on decode; the snapshot hash proves they match.
    w.uint(s.segments.length);
    w.uint(s.trail.length);
    let px = 0;
    let py = 0;
    for (const p of s.trail) {
      m.trail.write(e, p.x, px);
      m.trail.write(e, p.y, py);
      px = p.x;
      py = p.y;
    }
    m.tick.write(e, s.bornTick);
    w.uint(s.lifeTick);
    w.uint(s.kills);
    w.f64(s.maxMass, s.mass);
    w.f64(s.massArea);
    w.f64(s.score);
  }

  m.count.write(e, world.food.length);
  let prevId = 0;
  let prevValue = 0;
  for (const f of world.food) {
    m.foodId.write(e, f.id - prevId);
    m.foodXY.write(e, f.x);
    m.foodXY.write(e, f.y);
    m.foodValue.write(e, f.value, prevValue);
    m.kind.write(e, KINDS.indexOf(f.kind));
    prevId = f.id;
    prevValue = f.value;
  }
}

function readWorld(r: Reader, tick: number): World {
  const { d, m } = r;
  const config: Record<string, number> = {};
  for (let k = m.count.read(d); k > 0; k--) {
    const key = r.string();
    config[key] = r.f64();
  }
  checkConfig(config);
  const rng: World["rng"] = [r.f64(), r.f64(), r.f64(), r.f64()];
  const nextFoodId = r.uint();

  const deaths: Death[] = [];
  for (let k = m.count.read(d); k > 0; k--) {
    deaths.push({
      id: r.string(),
      author: r.string(),
      cause: CAUSES[m.cause.read(d)] as DeathCause,
      killerId: r.str(),
      killerAuthor: r.str(),
      tick: m.tick.read(d),
      lifeTicks: r.uint(),
      mass: r.f64(),
      maxMass: r.f64(),
      kills: r.uint(),
      score: r.f64(),
    });
  }

  const snakes: Snake[] = [];
  for (let k = m.count.read(d); k > 0; k--) {
    const id = r.string();
    const author = r.string();
    const seed = r.f64();
    const angle = r.f64();
    const speed = r.f64();
    const boosting = m.flag.read(d, FLAG_BOOSTING);
    const mass = r.f64();
    const size = r.f64();
    const segmentCount = r.uint();
    if (segmentCount > MAX_SEGMENTS) throw new Error("replay chunk: implausible segment count");
    const trail: Vec2[] = [];
    let px = 0;
    let py = 0;
    for (let n = r.uint(); n > 0; n--) {
      px = m.trail.read(d, px);
      py = m.trail.read(d, py);
      trail.push({ x: px, y: py });
    }
    const snake: Snake = {
      id,
      author,
      seed,
      head: { x: 0, y: 0 },
      angle,
      speed,
      boosting,
      mass,
      size,
      segments: [],
      trail,
      bornTick: m.tick.read(d),
      lifeTick: r.uint(),
      kills: r.uint(),
      maxMass: r.f64(mass),
      massArea: r.f64(),
      score: r.f64(),
    };
    layoutSegments(snake, segmentCount);
    snakes.push(snake);
  }

  const food: Food[] = [];
  let prevId = 0;
  let prevValue = 0;
  for (let k = m.count.read(d); k > 0; k--) {
    const id = prevId + m.foodId.read(d);
    const x = m.foodXY.read(d);
    const y = m.foodXY.read(d);
    const value = m.foodValue.read(d, prevValue);
    food.push({ id, x, y, value, kind: KINDS[m.kind.read(d)] as FoodKind });
    prevId = id;
    prevValue = value;
  }

  return {
    config: config as unknown as World["config"],
    tick,
    rng,
    snakes,
    food,
    nextFoodId,
    deaths,
  };
}

/** Rejects configs that would make `step` allocate or loop absurdly. */
function checkConfig(config: Record<string, number>): void {
  const bad = (what: string) => new Error(`replay chunk: implausible config (${what})`);
  for (const [key, v] of Object.entries(config)) if (!Number.isFinite(v)) throw bad(key);
  const c = config as unknown as EngineConfig;
  if (!(c.arenaHalfSize > 0 && c.gridCellSize > 0)) throw bad("arena or grid size");
  if (c.arenaHalfSize / c.gridCellSize > MAX_GRID_CELLS_PER_SIDE / 2) throw bad("grid too fine");
  if (!(c.minSize > 0 && c.maxSize >= c.minSize)) throw bad("snake size");
  const loops = [
    "baseSegments",
    "spawnAttempts",
    "spawnCandidates",
    "maxFood",
    "foodBase",
  ] as const;
  for (const key of loops) {
    if (c[key] > MAX_LOOP_CONFIG) throw bad(key);
  }
}

// --- Recording ---------------------------------------------------------------------------------

export interface ReplayRecorderOptions {
  /** Called with each finished chunk (and its plain form), in order. */
  onChunk: (bytes: Uint8Array, chunk: ReplayChunk) => void;
  /** Ticks per chunk. Default {@link CHUNK_TICKS} (two minutes). */
  chunkTicks?: number;
  /** Record a world hash on frames whose tick is a multiple of this. Default {@link HASH_EVERY}. */
  hashEvery?: number;
  /** An unfinished chunk saved from {@link ReplayRecorder.pending}, to continue after a restart. */
  pending?: ReplayChunk | null;
}

/**
 * Records a running world. Use its `spawn` and `step` in place of the engine's; they do the
 * same and log the inputs. Chunks are cut every `chunkTicks` ticks and handed to `onChunk`.
 */
export class ReplayRecorder {
  private chunk: ReplayChunk | null;
  private readonly onChunk: ReplayRecorderOptions["onChunk"];
  private readonly chunkTicks: number;
  private readonly hashEvery: number;

  constructor(
    readonly world: World,
    options: ReplayRecorderOptions,
  ) {
    this.onChunk = options.onChunk;
    this.chunkTicks = Math.max(1, options.chunkTicks ?? CHUNK_TICKS);
    this.hashEvery = Math.max(1, options.hashEvery ?? HASH_EVERY);
    this.chunk = options.pending ?? null;
  }

  /**
   * The chunk being recorded, as plain data. To resume recording after a restart, persist it
   * with the world and pass it back as `pending`. Store it encoded (`encodeReplayChunk`, tens of
   * KB) rather than as JSON (hundreds of KB for a full chunk).
   */
  get pending(): ReplayChunk | null {
    return this.chunk;
  }

  /** `spawnSnake`, recorded. Opens a chunk if none is open (the snapshot is taken first). */
  spawn(options: SpawnOptions): Snake {
    const chunk = this.chunk ?? this.open();
    const snake = spawnSnake(this.world, options);
    const last = chunk.ticks[chunk.ticks.length - 1];
    (last ? last.spawns : chunk.spawns).push({ ...options });
    return snake;
  }

  /** `step`, recorded. Starts a new chunk (snapshotting the current frame) when needed. */
  step(actions: ActionMap = {}, faults: FaultMap = {}): World {
    const world = this.world;
    if (this.chunk) {
      this.sealLastTick(false);
      if (this.chunk.ticks.length >= this.chunkTicks) this.flush();
    }
    const chunk = this.chunk ?? this.open();
    const n = world.snakes.length;
    const tick: ReplayTick = {
      turns: new Array(n),
      boosts: new Array(n),
      faults: [],
      spawns: [],
      hash: null,
    };
    for (let j = 0; j < n; j++) {
      const id = (world.snakes[j] as Snake).id;
      const action = actions[id];
      tick.turns[j] = quantizeTurn(action?.turn);
      tick.boosts[j] = action?.boost === true;
      const fault = faults[id];
      if (fault) tick.faults.push({ index: j, fault });
    }
    chunk.ticks.push(tick);
    return step(world, actions, faults);
  }

  /**
   * Ends the current chunk now (e.g. when the room shuts down), passes it to `onChunk` and
   * returns it; null if nothing was recorded since the last chunk. The next `step` opens a new
   * chunk.
   */
  flush(): Uint8Array | null {
    const chunk = this.chunk;
    if (!chunk || chunk.ticks.length === 0) return null;
    this.sealLastTick(true);
    this.chunk = null;
    const bytes = encodeReplayChunk(chunk);
    this.onChunk(bytes, chunk);
    return bytes;
  }

  private open(): ReplayChunk {
    const world = this.world;
    this.chunk = {
      snapshot: cloneWorld(world),
      snapshotHash: hashWorld(world),
      spawns: [],
      ticks: [],
    };
    return this.chunk;
  }

  /** The last tick's frame is complete (spawns done): hash it if due. */
  private sealLastTick(force: boolean): void {
    const last = this.chunk?.ticks[this.chunk.ticks.length - 1];
    if (!last || last.hash !== null) return;
    if (force || this.world.tick % this.hashEvery === 0) last.hash = hashWorld(this.world);
  }
}

// --- Playback ----------------------------------------------------------------------------------

export class ReplayDesyncError extends Error {
  constructor(
    readonly tick: number,
    detail: string,
  ) {
    super(`replay desync at tick ${tick}: ${detail}`);
    this.name = "ReplayDesyncError";
  }
}

export interface ReplayPlayerOptions {
  /** Check recorded hashes while playing and throw {@link ReplayDesyncError} on a mismatch. */
  verify?: boolean;
}

/**
 * Plays a replay back by re-running the engine. Any frame in [startTick, endTick] can be reached
 * with `seek`; it restarts from the nearest chunk snapshot at or before the target, so a seek
 * costs at most one chunk of simulation.
 */
export class ReplayPlayer {
  readonly startTick: number;
  readonly endTick: number;
  private readonly infos: ReplayChunkInfo[];
  private readonly verify: boolean;
  private chunkIndex = -1;
  private chunk: ReplayChunk | null = null;
  private current: World | null = null;

  /** `chunks`: consecutive encoded chunks of one room, in order. */
  constructor(
    private readonly chunks: readonly Uint8Array[],
    options: ReplayPlayerOptions = {},
  ) {
    if (chunks.length === 0) throw new Error("empty replay");
    this.verify = options.verify ?? true;
    this.infos = chunks.map(replayChunkInfo);
    for (let k = 1; k < this.infos.length; k++) {
      const prev = this.infos[k - 1] as ReplayChunkInfo;
      if ((this.infos[k] as ReplayChunkInfo).startTick !== prev.endTick) {
        throw new Error(`replay chunks ${k - 1} and ${k} are not consecutive`);
      }
    }
    this.startTick = (this.infos[0] as ReplayChunkInfo).startTick;
    this.endTick = (this.infos[this.infos.length - 1] as ReplayChunkInfo).endTick;
  }

  /** The current frame. Owned by the player and changed by `next`/`seek`: clone to keep it. */
  get world(): World {
    return this.current ?? this.seek(this.startTick);
  }

  get tick(): number {
    return this.world.tick;
  }

  /** The inputs that lead from the current frame to the next, or null at the end. */
  inputs(): ReplayTick | null {
    const world = this.world;
    const chunk = this.chunk as ReplayChunk;
    return chunk.ticks[world.tick - chunk.snapshot.tick] ?? null;
  }

  /** The current frame's actions by snake id, as `step` will get them; null at the end. */
  actions(): ActionMap | null {
    const t = this.inputs();
    return t && actionMap(this.world, t);
  }

  /** Moves to the frame at `tick` and returns it. */
  seek(tick: number): World {
    if (!Number.isInteger(tick) || tick < this.startTick || tick > this.endTick) {
      throw new RangeError(
        `tick ${tick} is outside the replay [${this.startTick}, ${this.endTick}]`,
      );
    }
    let k = this.infos.findIndex((c) => tick < c.endTick);
    if (k < 0) k = this.infos.length - 1;
    // Play forward from here if the target is ahead in the same chunk, else restart its chunk.
    if (!this.current || k !== this.chunkIndex || tick < this.current.tick) this.load(k);
    while ((this.current as World).tick < tick) this.next();
    return this.current as World;
  }

  /** Advances one tick and returns the new frame. Throws at the end of the replay. */
  next(): World {
    const world = this.world;
    const t = this.inputs();
    if (!t) throw new RangeError("end of replay");
    if (t.turns.length !== world.snakes.length) {
      throw new ReplayDesyncError(world.tick, "the number of living snakes differs");
    }
    step(world, actionMap(world, t), faultMap(world, t));
    for (const s of t.spawns) spawnSnake(world, s);
    if (this.verify && t.hash !== null && hashWorld(world) !== t.hash) {
      throw new ReplayDesyncError(world.tick, "world hash differs");
    }
    // At a chunk boundary the next chunk's snapshot is this world; carry on from it (plus any
    // snakes spawned before its first step).
    const info = this.infos[this.chunkIndex] as ReplayChunkInfo;
    if (world.tick === info.endTick && this.chunkIndex + 1 < this.chunks.length) {
      this.load(this.chunkIndex + 1);
      if (this.verify && hashWorld(world) !== (this.chunk as ReplayChunk).snapshotHash) {
        throw new ReplayDesyncError(world.tick, "the next chunk's snapshot differs");
      }
    }
    return this.current as World;
  }

  private load(k: number): void {
    if (k !== this.chunkIndex) {
      this.chunk = decodeReplayChunk(this.chunks[k] as Uint8Array);
      this.chunkIndex = k;
    }
    const chunk = this.chunk as ReplayChunk;
    this.current = cloneWorld(chunk.snapshot);
    for (const s of chunk.spawns) spawnSnake(this.current, s);
  }
}

function actionMap(world: World, t: ReplayTick): ActionMap {
  const actions: Record<string, Action> = {};
  for (let j = 0; j < t.turns.length; j++) {
    const s = world.snakes[j];
    if (s)
      actions[s.id] = { turn: (t.turns[j] as number) / TURN_STEPS, boost: t.boosts[j] === true };
  }
  return actions;
}

function faultMap(world: World, t: ReplayTick): FaultMap {
  const faults: Record<string, Fault> = {};
  for (const f of t.faults) {
    const s = world.snakes[f.index];
    if (s) faults[s.id] = f.fault;
  }
  return faults;
}
