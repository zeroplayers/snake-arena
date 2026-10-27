import type { EngineConfig } from "./config.ts";
import type { DeathCause, Food, FoodKind, Snake, Vec2, World } from "./types.ts";
import { layoutSegments } from "./world.ts";

/**
 * Spectator broadcast of a room (SPEC §4 showcase rooms, #27): per-tick state deltas built from
 * the engine world, as compact versioned binary messages, and the view a spectator rebuilds from
 * them.
 *
 * Unlike a replay, a spectator never runs the engine: it gets each tick's state. Bodies are the
 * one thing too big to send every tick (every segment moves each tick), so a snake is sent once
 * with its trail (the head's path that its body is laid along) and from then on only its new head,
 * size and segment count; `BroadcastView` lays the body out along that trail exactly as the
 * engine does (`layoutSegments`). Pellets are sent once, when they appear, and by id when eaten.
 *
 *   const encoder = new BroadcastEncoder(world, { stream, label: (id) => publicLabelOf(id) });
 *   send(encodeBroadcast(encoder.keyframe(world)));             // a new spectator
 *   step(world, actions);
 *   const delta = encoder.step(world);                          // after every step
 *   send(encodeBroadcast({ kind: "ticks", stream, ticks: [delta, …] }));
 *
 *   const view = new BroadcastView();
 *   view.apply(decodeBroadcast(bytes));                         // keyframe, then deltas
 *   view.snakes; view.food; view.deaths;
 *
 * **Only public fields go on the wire.** Lives are known by their slot, and labelled with what the
 * site shows anyway (`BroadcastLabel`: username, bot slug, version number), never by the internal
 * ids of lives, users, versions or rooms.
 *
 * A **stream** is one encoder's sequence of ticks: deltas apply only on top of the same stream's
 * previous tick. A spectator that misses a tick (or joins, or meets a new stream after the room
 * restarted) needs a keyframe.
 *
 * Wire format (little-endian): `0x5a`, `BROADCAST_VERSION`, kind, then the body. Positions, angles
 * and masses are float32, so a spectator's bodies match the room's to ~1e-5 units. Strings are
 * UTF-16 code units (as in replays; the engine has no text codecs), labels cut to 100 of them.
 */
/** 3: keyframes carry the square arena's config (`arenaHalfSize`, #76). */
export const BROADCAST_VERSION = 3;

const MAGIC = 0x5a;
const KIND_KEYFRAME = 1;
const KIND_TICKS = 2;
/**
 * Trail points sent per snake, newest kept. A trail only covers the snake's body (the engine
 * prunes it), so this binds only absurdly long snakes; it keeps a keyframe of a full room
 * (20 snakes and `maxFood` pellets) under ~400 KB.
 */
export const MAX_TRAIL_POINTS = 2048;
/** Longest author or bot label sent, in UTF-16 code units. */
const MAX_LABEL_UNITS = 100;

const CAUSES: readonly DeathCause[] = ["collision", "wall", "timeout", "error", "retired"];
const FOOD_KINDS: readonly FoodKind[] = ["ambient", "boost", "remains"];
const BOOSTING = 1;
const NEW_SNAKE = 2;
const NO_SLOT = 0xffff;
const HOUSE = 1;

/**
 * What spectators are told about a life: the public names the site shows, nothing internal.
 * Empty strings and version 0 when the room couldn't look them up.
 */
export interface BroadcastLabel {
  /** The owner's username; `house` for a house bot. */
  readonly author: string;
  /** The bot's slug; a house bot's kind. */
  readonly bot: string;
  /** The version's number (`versions.n`); 0 for a house bot. */
  readonly version: number;
  readonly house: boolean;
}

/** A life as spectators know it. `slot` is its only id, and only within the stream. */
export interface BroadcastLife extends BroadcastLabel {
  readonly slot: number;
  readonly bornTick: number;
}

/** One living snake on one tick. */
export interface BroadcastSnake {
  readonly slot: number;
  /** Head; the newest trail point. */
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly mass: number;
  readonly size: number;
  /** Segment count, head included. */
  readonly segments: number;
  readonly boosting: boolean;
  readonly kills: number;
  readonly score: number;
  /** Only for a snake new to spectators (keyframe, spawn): its life and trail, oldest first. */
  readonly life?: BroadcastLife;
  readonly trail?: readonly Vec2[];
}

export interface BroadcastDeath {
  readonly slot: number;
  readonly cause: DeathCause;
  readonly killerSlot: number | null;
  readonly score: number;
  readonly mass: number;
  readonly kills: number;
}

export interface BroadcastFood {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly kind: FoodKind;
}

/** What changed on the way to `tick`. */
export interface TickDelta {
  readonly tick: number;
  /** Every living snake, in world order. */
  readonly snakes: readonly BroadcastSnake[];
  /** Lives that ended on this tick (they are not in `snakes`). */
  readonly deaths: readonly BroadcastDeath[];
  /** Pellets gone since the previous tick. */
  readonly eaten: readonly number[];
  /** Pellets new since the previous tick. */
  readonly food: readonly BroadcastFood[];
}

/** Everything a spectator needs to start watching at `tick`. */
export interface Keyframe {
  readonly kind: "keyframe";
  readonly stream: number;
  readonly tick: number;
  readonly config: EngineConfig;
  /** Every living snake, with its life and trail. */
  readonly snakes: readonly BroadcastSnake[];
  readonly food: readonly BroadcastFood[];
}

/** Consecutive ticks of a stream. */
export interface TicksMessage {
  readonly kind: "ticks";
  readonly stream: number;
  readonly ticks: readonly TickDelta[];
}

export type BroadcastMessage = Keyframe | TicksMessage;

/** A message of another protocol version, or not a broadcast message at all. */
export class BroadcastFormatError extends Error {
  override name = "BroadcastFormatError";
}

/** A delta that doesn't follow the view's tick (a missed message, or another stream). */
export class BroadcastGapError extends Error {
  override name = "BroadcastGapError";
}

export interface BroadcastEncoderOptions {
  /** Distinguishes this encoder's ticks from any other's (e.g. before a room restarted). */
  readonly stream: number;
  /** The public label of a life, by its engine id (which isn't sent). */
  readonly label: (lifeId: string) => BroadcastLabel;
}

/**
 * Builds a stream from a world: `step` after every engine step, `keyframe` at any frame it has
 * seen. It keeps only what spectators were told (slots, pellet ids), not a copy of the world.
 */
export class BroadcastEncoder {
  readonly stream: number;
  private tickNo: number;
  private readonly slots = new Map<string, number>();
  private nextSlot = 0;
  private food = new Set<number>();

  /** Starts the stream at `world`'s frame (its first keyframe). */
  constructor(
    world: World,
    private readonly options: BroadcastEncoderOptions,
  ) {
    this.stream = options.stream >>> 0;
    this.tickNo = world.tick;
    for (const s of world.snakes) this.slotOf(s.id);
    for (const f of world.food) this.food.add(f.id);
  }

  /** The last frame encoded. */
  get tick(): number {
    return this.tickNo;
  }

  keyframe(world: World): Keyframe {
    if (world.tick !== this.tickNo) {
      throw new Error(`keyframe of tick ${world.tick}, stream is at ${this.tickNo}`);
    }
    return {
      kind: "keyframe",
      stream: this.stream,
      tick: world.tick,
      config: world.config,
      snakes: world.snakes.map((s) => this.snake(s, true)),
      food: world.food.map(food),
    };
  }

  /** The delta to `world`'s frame, the one right after the last one encoded. */
  step(world: World): TickDelta {
    if (world.tick !== this.tickNo + 1) {
      throw new Error(`delta to tick ${world.tick}, stream is at ${this.tickNo}`);
    }
    this.tickNo = world.tick;
    const snakes = world.snakes.map((s) => this.snake(s, !this.slots.has(s.id)));
    const deaths: BroadcastDeath[] = [];
    for (const d of world.deaths) {
      const slot = this.slots.get(d.id);
      // Spawned and killed before spectators saw it (e.g. an evicted life): nothing to show.
      if (slot === undefined) continue;
      deaths.push({
        slot,
        cause: d.cause,
        killerSlot: d.killerId === null ? null : (this.slots.get(d.killerId) ?? null),
        score: d.score,
        mass: d.mass,
        kills: d.kills,
      });
    }
    if (this.slots.size > world.snakes.length) {
      const alive = new Set(world.snakes.map((s) => s.id));
      for (const id of this.slots.keys()) if (!alive.has(id)) this.slots.delete(id);
    }
    const now = new Set<number>();
    const added: BroadcastFood[] = [];
    for (const f of world.food) {
      now.add(f.id);
      if (!this.food.has(f.id)) added.push(food(f));
    }
    const eaten: number[] = [];
    for (const id of this.food) if (!now.has(id)) eaten.push(id);
    this.food = now;
    return { tick: world.tick, snakes, deaths, eaten, food: added };
  }

  private snake(s: Snake, full: boolean): BroadcastSnake {
    const slot = this.slotOf(s.id);
    const base: BroadcastSnake = {
      slot,
      x: s.head.x,
      y: s.head.y,
      angle: s.angle,
      mass: s.mass,
      size: s.size,
      segments: s.segments.length,
      boosting: s.boosting,
      kills: s.kills,
      score: s.score,
    };
    if (!full) return base;
    return {
      ...base,
      life: { ...label(this.options.label(s.id)), slot, bornTick: s.bornTick },
      trail: s.trail.slice(-MAX_TRAIL_POINTS),
    };
  }

  /** A life's slot, assigned on first sight; skips slots still in use when the counter wraps. */
  private slotOf(id: string): number {
    const known = this.slots.get(id);
    if (known !== undefined) return known;
    const used = new Set(this.slots.values());
    let slot = this.nextSlot;
    while (used.has(slot)) slot = (slot + 1) % NO_SLOT;
    this.nextSlot = (slot + 1) % NO_SLOT;
    this.slots.set(id, slot);
    return slot;
  }
}

/** Just the label's fields, whatever else the caller's object holds. */
function label(l: BroadcastLabel): BroadcastLabel {
  return { author: l.author, bot: l.bot, version: l.version, house: l.house };
}

function food(f: Food): BroadcastFood {
  return { id: f.id, x: f.x, y: f.y, kind: f.kind };
}

// --- Wire format --------------------------------------------------------------------------------

export function encodeBroadcast(message: BroadcastMessage): Uint8Array {
  const w = new Writer();
  w.u8(MAGIC);
  w.u8(BROADCAST_VERSION);
  if (message.kind === "keyframe") {
    w.u8(KIND_KEYFRAME);
    w.u32(message.stream);
    w.u32(message.tick);
    w.str(JSON.stringify(message.config), 0xffff);
    writeSnakes(w, message.snakes);
    w.u32(message.food.length);
    for (const f of message.food) writeFood(w, f);
  } else {
    w.u8(KIND_TICKS);
    w.u32(message.stream);
    w.u16(message.ticks.length);
    for (const t of message.ticks) {
      w.u32(t.tick);
      writeSnakes(w, t.snakes);
      w.u16(t.deaths.length);
      for (const d of t.deaths) {
        w.u16(d.slot);
        w.u8(CAUSES.indexOf(d.cause));
        w.u16(d.killerSlot ?? NO_SLOT);
        w.f32(d.score);
        w.f32(d.mass);
        w.u16(Math.min(d.kills, 0xffff));
      }
      w.u32(t.eaten.length);
      for (const id of t.eaten) w.u32(id);
      w.u32(t.food.length);
      for (const f of t.food) writeFood(w, f);
    }
  }
  return w.bytes();
}

/** Decodes one message; throws `BroadcastFormatError` on anything that isn't a valid one. */
export function decodeBroadcast(bytes: Uint8Array): BroadcastMessage {
  const r = new Reader(bytes);
  try {
    if (r.u8() !== MAGIC) throw new BroadcastFormatError("not a broadcast message");
    const version = r.u8();
    if (version !== BROADCAST_VERSION) {
      throw new BroadcastFormatError(`broadcast version ${version}, expected ${BROADCAST_VERSION}`);
    }
    const kind = r.u8();
    let message: BroadcastMessage;
    if (kind === KIND_KEYFRAME) {
      const stream = r.u32();
      const tick = r.u32();
      const config = JSON.parse(r.str()) as EngineConfig;
      const snakes = readSnakes(r);
      const food: BroadcastFood[] = [];
      for (let n = r.count(r.u32(), 13); n > 0; n--) food.push(readFood(r));
      message = { kind: "keyframe", stream, tick, config, snakes, food };
    } else if (kind === KIND_TICKS) {
      const stream = r.u32();
      const ticks: TickDelta[] = [];
      for (let n = r.count(r.u16(), 8); n > 0; n--) {
        const tick = r.u32();
        const snakes = readSnakes(r);
        const deaths: BroadcastDeath[] = [];
        for (let k = r.count(r.u16(), 17); k > 0; k--) {
          const slot = r.u16();
          const cause = CAUSES[r.u8()];
          if (!cause) throw new BroadcastFormatError("unknown death cause");
          const killer = r.u16();
          deaths.push({
            slot,
            cause,
            killerSlot: killer === NO_SLOT ? null : killer,
            score: r.f32(),
            mass: r.f32(),
            kills: r.u16(),
          });
        }
        const eaten: number[] = [];
        for (let k = r.count(r.u32(), 4); k > 0; k--) eaten.push(r.u32());
        const food: BroadcastFood[] = [];
        for (let k = r.count(r.u32(), 13); k > 0; k--) food.push(readFood(r));
        ticks.push({ tick, snakes, deaths, eaten, food });
      }
      message = { kind: "ticks", stream, ticks };
    } else {
      throw new BroadcastFormatError(`unknown message kind ${kind}`);
    }
    if (!r.done) throw new BroadcastFormatError("trailing bytes");
    return message;
  } catch (e) {
    if (e instanceof BroadcastFormatError) throw e;
    throw new BroadcastFormatError(`malformed broadcast message: ${String(e)}`);
  }
}

function writeSnakes(w: Writer, snakes: readonly BroadcastSnake[]): void {
  w.u16(snakes.length);
  for (const s of snakes) {
    const full = s.life !== undefined && s.trail !== undefined;
    w.u16(s.slot);
    w.u8((s.boosting ? BOOSTING : 0) | (full ? NEW_SNAKE : 0));
    w.f32(s.x);
    w.f32(s.y);
    w.f32(s.angle);
    w.f32(s.mass);
    w.f32(s.size);
    w.u16(Math.min(s.segments, 0xffff));
    w.u16(Math.min(s.kills, 0xffff));
    w.f32(s.score);
    if (full && s.life && s.trail) {
      w.str(s.life.author);
      w.str(s.life.bot);
      w.u32(s.life.version);
      w.u8(s.life.house ? HOUSE : 0);
      w.u32(s.life.bornTick);
      const trail = s.trail.slice(-MAX_TRAIL_POINTS);
      w.u16(trail.length);
      for (const p of trail) {
        w.f32(p.x);
        w.f32(p.y);
      }
    }
  }
}

function readSnakes(r: Reader): BroadcastSnake[] {
  const snakes: BroadcastSnake[] = [];
  for (let n = r.count(r.u16(), 29); n > 0; n--) {
    const slot = r.u16();
    const flags = r.u8();
    const s = {
      slot,
      boosting: (flags & BOOSTING) !== 0,
      x: r.f32(),
      y: r.f32(),
      angle: r.f32(),
      mass: r.f32(),
      size: r.f32(),
      segments: r.u16(),
      kills: r.u16(),
      score: r.f32(),
    };
    if ((flags & NEW_SNAKE) === 0) {
      snakes.push(s);
      continue;
    }
    const life: BroadcastLife = {
      slot,
      author: r.str(),
      bot: r.str(),
      version: r.u32(),
      house: (r.u8() & HOUSE) !== 0,
      bornTick: r.u32(),
    };
    const trail: Vec2[] = [];
    for (let k = r.count(r.u16(), 8); k > 0; k--) trail.push({ x: r.f32(), y: r.f32() });
    if (trail.length === 0) throw new BroadcastFormatError("snake without a trail");
    snakes.push({ ...s, life, trail });
  }
  return snakes;
}

function writeFood(w: Writer, f: BroadcastFood): void {
  w.u32(f.id);
  w.f32(f.x);
  w.f32(f.y);
  w.u8(FOOD_KINDS.indexOf(f.kind));
}

function readFood(r: Reader): BroadcastFood {
  const id = r.u32();
  const x = r.f32();
  const y = r.f32();
  const kind = FOOD_KINDS[r.u8()];
  if (!kind) throw new BroadcastFormatError("unknown food kind");
  return { id, x, y, kind };
}

class Writer {
  private buf = new Uint8Array(1024);
  private view = new DataView(this.buf.buffer);
  private pos = 0;

  u8(v: number): void {
    this.reserve(1);
    this.view.setUint8(this.pos, v);
    this.pos += 1;
  }
  u16(v: number): void {
    this.reserve(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
  }
  u32(v: number): void {
    this.reserve(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
  }
  f32(v: number): void {
    this.reserve(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
  }
  /** A string as u16 code units after a u16 count, cut to `max` (not inside a surrogate pair). */
  str(s: string, max = MAX_LABEL_UNITS): void {
    let n = Math.min(s.length, max);
    if (n < s.length && n > 0 && (s.charCodeAt(n - 1) & 0xfc00) === 0xd800) n--;
    this.u16(n);
    for (let i = 0; i < n; i++) this.u16(s.charCodeAt(i));
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
  private reserve(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n));
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
}

class Reader {
  private readonly view: DataView;
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get done(): boolean {
    return this.pos === this.buf.length;
  }
  u8(): number {
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }
  u16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f32(): number {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  str(): string {
    const n = this.count(this.u16(), 2);
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u16());
    return s;
  }
  /** A count of items of at least `minBytes` each, refused if they can't fit in what's left. */
  count(n: number, minBytes: number): number {
    if (n * minBytes > this.buf.length - this.pos)
      throw new BroadcastFormatError("count past the end");
    return n;
  }
}

// --- The spectator's side -----------------------------------------------------------------------

/**
 * A living snake as a spectator sees it: its life and an engine snake rebuilt from the stream.
 * The snake's `id` is `<stream>.<slot>` (life ids aren't sent), its `author` the username.
 */
export interface ViewSnake {
  readonly life: BroadcastLife;
  /** Laid out by the engine's own `layoutSegments`; fields spectators aren't sent are zero. */
  readonly snake: Snake;
}

export interface ViewDeath extends BroadcastDeath {
  readonly life: BroadcastLife;
}

/**
 * The world a spectator rebuilds: `apply` a keyframe, then each following delta. Not a full
 * engine world (no PRNG, trails only as sent), just enough to draw and list it.
 */
export class BroadcastView {
  stream: number | null = null;
  tick = 0;
  config: EngineConfig | null = null;
  /** Living snakes in world order. */
  snakes: ViewSnake[] = [];
  readonly food = new Map<number, Food>();
  /** Lives that ended on `tick`. */
  deaths: ViewDeath[] = [];
  private readonly bySlot = new Map<number, ViewSnake>();

  /** Applies a message. Throws `BroadcastGapError` if a delta doesn't follow `tick`. */
  apply(message: BroadcastMessage): void {
    if (message.kind === "keyframe") this.applyKeyframe(message);
    else for (const t of message.ticks) this.applyTick(message.stream, t);
  }

  applyKeyframe(k: Keyframe): void {
    this.stream = k.stream;
    this.tick = k.tick;
    this.config = k.config;
    this.bySlot.clear();
    this.snakes = k.snakes.map((s) => this.spawn(s, k.tick));
    for (const v of this.snakes) this.bySlot.set(v.life.slot, v);
    this.food.clear();
    for (const f of k.food) this.addFood(f);
    this.deaths = [];
  }

  applyTick(stream: number, t: TickDelta): void {
    if (stream !== this.stream || t.tick !== this.tick + 1 || !this.config) {
      throw new BroadcastGapError(
        `tick ${t.tick} of stream ${stream} after tick ${this.tick} of stream ${this.stream}`,
      );
    }
    for (const s of t.snakes) {
      if (!s.trail && !this.bySlot.has(s.slot)) {
        throw new BroadcastGapError(`tick ${t.tick}: snake ${s.slot} was never sent`);
      }
    }
    const deaths: ViewDeath[] = [];
    for (const d of t.deaths) {
      const life = this.bySlot.get(d.slot)?.life;
      if (life) deaths.push({ ...d, life });
    }
    const snakes = t.snakes.map((s) => {
      const known = s.trail ? undefined : this.bySlot.get(s.slot);
      return known ? this.move(known, s, t.tick) : this.spawn(s, t.tick);
    });
    this.bySlot.clear();
    for (const v of snakes) this.bySlot.set(v.life.slot, v);
    this.snakes = snakes;
    for (const id of t.eaten) this.food.delete(id);
    for (const f of t.food) this.addFood(f);
    this.deaths = deaths;
    this.tick = t.tick;
  }

  private spawn(s: BroadcastSnake, tick: number): ViewSnake {
    if (!s.life || !s.trail) throw new BroadcastGapError(`snake ${s.slot} sent without its life`);
    const snake: Snake = {
      id: `${this.stream}.${s.slot}`,
      author: s.life.author,
      seed: 0,
      head: { x: s.x, y: s.y },
      angle: s.angle,
      speed: 0,
      boosting: s.boosting,
      mass: s.mass,
      size: s.size,
      segments: [],
      trail: s.trail.map((p) => ({ x: p.x, y: p.y })),
      bornTick: s.life.bornTick,
      lifeTick: tick - s.life.bornTick,
      kills: s.kills,
      maxMass: s.mass,
      massArea: 0,
      score: s.score,
    };
    layoutSegments(snake, Math.max(1, s.segments));
    return { life: s.life, snake };
  }

  private move(v: ViewSnake, s: BroadcastSnake, tick: number): ViewSnake {
    const snake = v.snake;
    snake.lifeTick = tick - snake.bornTick;
    snake.trail.push({ x: s.x, y: s.y });
    snake.angle = s.angle;
    snake.boosting = s.boosting;
    snake.mass = s.mass;
    snake.maxMass = Math.max(snake.maxMass, s.mass);
    snake.size = s.size;
    snake.kills = s.kills;
    snake.score = s.score;
    layoutSegments(snake, Math.max(1, s.segments));
    return v;
  }

  /** Pellet values aren't sent: spectators only draw pellets. */
  private addFood(f: BroadcastFood): void {
    this.food.set(f.id, { ...f, value: 0 });
  }
}
