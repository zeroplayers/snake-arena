import {
  type Action,
  type ActionMap,
  cloneWorld,
  createWorld,
  type EngineConfig,
  type Food,
  type Snake,
  type SpawnOptions,
  spawnSnake,
  step,
  TICK_RATE,
  type World,
} from "@zerosnake/engine";
import { type RenderFood, type RenderSnake, SNAKE_PALETTE } from "@zerosnake/renderer";
import { createTickLog, type LogFn, type TickLog } from "@zerosnake/sdk";
import { foodDisplaySize } from "../food.ts";
import type {
  BotTrace,
  LifeInfo,
  MatchInfo,
  MatchSource,
  SnakeTick,
  TickSnapshot,
} from "../types.ts";

/**
 * Fallback for engines without `config.visionRadius` (SPEC §3 "only a radius around the
 * head"): a bit under a third of the default arena radius.
 */
export const DEFAULT_VISION_RADIUS = 30;

/** Ticks between stored world copies; any other tick is re-simulated from the one before. */
export const KEYFRAME_INTERVAL = 100;

/**
 * A bot run in the page. It gets the engine's own snake and world (not a vision-limited
 * `BotState`), so it is trusted code: stand-ins and house bots, not user uploads. Sandboxed
 * bots plug in here later with the same shape.
 */
export interface LiveBot {
  /** Shown in the snake list; lives of this bot get ids `name#1`, `name#2`, … */
  readonly name: string;
  readonly author?: string;
  /** `#rrggbb`; picked from the renderer palette when omitted. */
  readonly color?: string;
  act(snake: Snake, world: World, log: LogFn): Action;
}

export interface LiveSourceOptions {
  readonly bots: readonly LiveBot[];
  readonly seed?: number;
  readonly config?: Partial<EngineConfig>;
  /** Default: the engine's `config.visionRadius`, else `DEFAULT_VISION_RADIUS`. */
  readonly visionRadius?: number;
  /** Ticks between a death and the bot's next life. Default 20. */
  readonly respawnDelay?: number;
  /** Ticks kept for scrubbing; older ones are dropped. Default 18 000 (30 min at 10 tps). */
  readonly maxTicks?: number;
  readonly title?: string;
}

interface Slot {
  readonly bot: LiveBot;
  readonly color: string;
  readonly log: TickLog;
  lives: number;
  snakeId: string | undefined;
  respawnAt: number;
}

type MutableLife = { -readonly [K in keyof LifeInfo]: LifeInfo[K] };

/**
 * `log()` output of one call: nothing, one line, several lines joined by `\n`, or the array
 * itself when a line contains `\n`. Strings cost far less than an array per call.
 */
type StoredLog = string | readonly string[] | undefined;

/**
 * `KEYFRAME_INTERVAL` ticks of history: the world at `start`, then only what can't be
 * re-simulated (bot output, spawns) plus deaths, packed per tick. Entry `e` of a tick is the
 * snake `ids[tick][e - entry[tick]]`, in world order.
 */
interface Chunk {
  readonly start: number;
  /** The world at `start`, after that tick's spawns. Never stepped. */
  readonly keyframe: World;
  readonly ids: (readonly string[])[];
  readonly entry: number[];
  turns: Float64Array;
  boosts: Uint8Array;
  truncated: Uint8Array;
  readonly logs: StoredLog[];
  /** Lives started right after stepping into the tick. */
  readonly spawns: (readonly SpawnOptions[] | undefined)[];
  readonly deaths: (readonly string[] | undefined)[];
}

const NO_DEATHS: readonly string[] = [];
/** Built snapshots kept around: playback reads a few neighbouring ticks every frame. */
const SNAPSHOT_CACHE = 32;

/**
 * Runs the engine in the page, one tick per `request`ed tick, and keeps the history for
 * scrubbing. Bots act right after each tick is simulated, so a tick carries the action and
 * logs of the call that saw it.
 *
 * History is a keyframe every `KEYFRAME_INTERVAL` ticks plus each tick's bot output; a past
 * tick is rebuilt by stepping from its keyframe with the recorded actions (the engine is
 * deterministic). Sequential playback steps a cursor forward, so it costs one engine step
 * per tick; a random seek costs at most one interval of steps.
 */
export class LiveEngineSource implements MatchSource {
  readonly info: MatchInfo;
  readonly endTick = undefined;
  readonly world: World;

  private readonly slots: Slot[];
  private readonly slotBySnake = new Map<string, Slot>();
  private readonly lifeList: MutableLife[] = [];
  private readonly lifeById = new Map<string, MutableLife>();
  private readonly chunks: Chunk[] = [];
  private readonly cache = new Map<number, TickSnapshot>();
  private readonly foodCache = new Map<number, RenderFood>();
  private readonly respawnDelay: number;
  private readonly maxTicks: number;
  private cursor: { world: World; tick: number } | undefined;
  private lastIds: readonly string[] = [];

  constructor(options: LiveSourceOptions) {
    this.world = createWorld({
      seed: options.seed ?? 1,
      ...(options.config && { config: options.config }),
    });
    const engineVision = (this.world.config as { visionRadius?: number }).visionRadius;
    this.info = {
      tps: TICK_RATE,
      arenaHalfSize: this.world.config.arenaHalfSize,
      visionRadius: options.visionRadius ?? engineVision ?? DEFAULT_VISION_RADIUS,
      ...(options.title !== undefined && { title: options.title }),
    };
    this.respawnDelay = options.respawnDelay ?? 20;
    this.maxTicks = Math.max(2, options.maxTicks ?? 18_000);
    this.slots = options.bots.map((bot, i) => ({
      bot,
      color: bot.color ?? (SNAKE_PALETTE[i % SNAKE_PALETTE.length] as string),
      log: createTickLog(),
      lives: 0,
      snakeId: undefined,
      respawnAt: 0,
    }));
    const spawned = this.spawnDue();
    this.record(spawned, NO_DEATHS);
  }

  get firstTick(): number {
    return this.chunks[0]?.start ?? 0;
  }

  get lastTick(): number {
    return this.world.tick;
  }

  request(tick: number): void {
    while (this.world.tick < tick) this.advance();
  }

  snapshot(tick: number): TickSnapshot | undefined {
    if (!Number.isInteger(tick) || tick < this.firstTick || tick > this.lastTick) return undefined;
    const hit = this.cache.get(tick);
    if (hit) {
      // Refresh its place in the LRU order.
      this.cache.delete(tick);
      this.cache.set(tick, hit);
      return hit;
    }
    const snap = this.build(tick === this.lastTick ? this.world : this.worldAt(tick));
    this.cache.set(tick, snap);
    if (this.cache.size > SNAPSHOT_CACHE) {
      const oldest = this.cache.keys().next().value as number;
      this.cache.delete(oldest);
    }
    return snap;
  }

  trace(id: string, tick: number): BotTrace | undefined {
    const chunk = this.chunkFor(tick);
    if (!chunk) return undefined;
    const k = tick - chunk.start;
    const i = chunk.ids[k]?.indexOf(id) ?? -1;
    return i < 0 ? undefined : traceAt(chunk, (chunk.entry[k] as number) + i);
  }

  lives(): readonly LifeInfo[] {
    return this.lifeList;
  }

  life(id: string): LifeInfo | undefined {
    return this.lifeById.get(id);
  }

  private advance(): void {
    const world = step(this.world, this.actionsAt(this.world.tick));
    const ended: string[] = [];
    for (const d of world.deaths) {
      ended.push(d.id);
      const life = this.lifeById.get(d.id);
      if (life) {
        life.death = {
          tick: d.tick,
          cause: d.cause,
          killerId: d.killerId,
          score: d.score,
          mass: d.mass,
          kills: d.kills,
        };
      }
      const slot = this.slotBySnake.get(d.id);
      if (slot) {
        slot.snakeId = undefined;
        slot.respawnAt = world.tick + this.respawnDelay;
      }
      this.slotBySnake.delete(d.id);
    }
    this.record(this.spawnDue(), ended.length > 0 ? ended : NO_DEATHS);
  }

  private spawnDue(): SpawnOptions[] {
    const world = this.world;
    const spawned: SpawnOptions[] = [];
    for (const slot of this.slots) {
      if (slot.snakeId !== undefined || world.tick < slot.respawnAt) continue;
      slot.lives++;
      const id = `${slot.bot.name}#${slot.lives}`;
      const author = slot.bot.author ?? slot.bot.name;
      spawnSnake(world, { id, author });
      spawned.push({ id, author });
      slot.snakeId = id;
      this.slotBySnake.set(id, slot);
      const life: MutableLife = {
        id,
        bot: slot.bot.name,
        author,
        color: slot.color,
        bornTick: world.tick,
      };
      this.lifeList.push(life);
      this.lifeById.set(id, life);
    }
    return spawned;
  }

  /** Runs the bots on the current tick and appends it to the history. */
  private record(spawned: readonly SpawnOptions[], deaths: readonly string[]): void {
    const world = this.world;
    const tick = world.tick;
    let chunk = this.chunks[this.chunks.length - 1];
    if (!chunk || tick - chunk.start >= KEYFRAME_INTERVAL) {
      chunk = newChunk(tick, copyWorld(world));
      this.chunks.push(chunk);
      this.evict();
    }
    const k = tick - chunk.start;
    if (spawned.length > 0) chunk.spawns[k] = spawned;
    if (deaths.length > 0) chunk.deaths[k] = deaths;

    // Share the id list with the previous tick while nobody spawned or died.
    const snakes = world.snakes;
    const same =
      snakes.length === this.lastIds.length && snakes.every((s, i) => s.id === this.lastIds[i]);
    if (!same) this.lastIds = snakes.map((s) => s.id);
    chunk.ids[k] = this.lastIds;

    const base = k === 0 ? 0 : (chunk.entry[k - 1] as number) + (chunk.ids[k - 1]?.length ?? 0);
    chunk.entry[k] = base;
    reserve(chunk, base + snakes.length);
    snakes.forEach((snake, i) => {
      const e = base + i;
      const slot = this.slotBySnake.get(snake.id);
      if (!slot) {
        chunk.turns[e] = 0;
        return;
      }
      const action = runBot(slot, snake, world);
      const out = slot.log.flush();
      chunk.turns[e] = Number(action?.turn);
      chunk.boosts[e] = action?.boost === true ? 1 : 0;
      chunk.truncated[e] = out.truncated ? 1 : 0;
      chunk.logs[e] = packLog(out.lines);
    });
    // The live tick changed (it now has actions): drop a snapshot built before.
    this.cache.delete(tick);
  }

  private evict(): void {
    while (this.chunks.length > 1) {
      const second = this.chunks[1] as Chunk;
      if (this.world.tick - second.start < this.maxTicks) break;
      this.chunks.shift();
    }
    for (const t of this.cache.keys()) if (t < this.firstTick) this.cache.delete(t);
  }

  private chunkFor(tick: number): Chunk | undefined {
    const first = this.chunks[0];
    if (!first || tick < first.start || tick > this.lastTick) return undefined;
    return this.chunks[Math.floor((tick - first.start) / KEYFRAME_INTERVAL)];
  }

  /** Recorded actions of the bots that saw `tick`. */
  private actionsAt(tick: number): ActionMap {
    const chunk = this.chunkFor(tick) as Chunk;
    const k = tick - chunk.start;
    const ids = chunk.ids[k] as readonly string[];
    const base = chunk.entry[k] as number;
    const actions: Record<string, Action> = {};
    ids.forEach((id, i) => {
      actions[id] = { turn: chunk.turns[base + i] as number, boost: chunk.boosts[base + i] === 1 };
    });
    return actions;
  }

  /** The world as it was on a past `tick`, re-simulated from the nearest keyframe. */
  private worldAt(tick: number): World {
    const chunk = this.chunkFor(tick) as Chunk;
    let c = this.cursor;
    if (!c || c.tick > tick || c.tick < chunk.start) {
      c = { world: copyWorld(chunk.keyframe), tick: chunk.start };
      this.cursor = c;
    }
    while (c.tick < tick) {
      step(c.world, this.actionsAt(c.tick));
      c.tick++;
      const at = this.chunkFor(c.tick) as Chunk;
      for (const spawn of at.spawns[c.tick - at.start] ?? []) spawnSnake(c.world, spawn);
    }
    return c.world;
  }

  private build(world: World): TickSnapshot {
    const tick = world.tick;
    const chunk = this.chunkFor(tick) as Chunk;
    const k = tick - chunk.start;
    const base = chunk.entry[k] as number;
    const snakes: SnakeTick[] = [];
    const renderSnakes: RenderSnake[] = [];
    world.snakes.forEach((snake, i) => {
      const life = this.lifeById.get(snake.id);
      snakes.push({
        id: snake.id,
        score: snake.score,
        mass: snake.mass,
        segments: snake.segments.length,
        kills: snake.kills,
        lifeTick: snake.lifeTick,
        boosting: snake.boosting,
        ...(life && traceAt(chunk, base + i)),
      });
      renderSnakes.push({
        id: snake.id,
        segments: snake.segments.map((p) => ({ x: p.x, y: p.y })),
        angle: snake.angle,
        length: snake.mass,
        radius: snake.size / 2,
        ...(life && { skin: { color: life.color } }),
      });
    });
    return {
      tick,
      frame: {
        tick,
        arenaHalfSize: world.config.arenaHalfSize,
        snakes: renderSnakes,
        food: this.renderFood(world.food),
      },
      snakes,
      deaths: chunk.deaths[k] ?? NO_DEATHS,
    };
  }

  /** Pellets never move, so each one is mapped once and shared by the snapshots holding it. */
  private renderFood(food: readonly Food[]): RenderFood[] {
    const c = this.world.config;
    const out: RenderFood[] = [];
    for (const f of food) {
      let r = this.foodCache.get(f.id);
      if (!r) {
        r = {
          id: f.id,
          x: f.x,
          y: f.y,
          size: foodDisplaySize(f.kind, c),
        };
        this.foodCache.set(f.id, r);
      }
      out.push(r);
    }
    // Ids only grow; keep the cache to pellets that can still exist.
    if (this.foodCache.size > 4 * Math.max(64, food.length)) {
      const alive = new Set(this.world.food.map((f) => f.id));
      for (const id of this.foodCache.keys()) if (!alive.has(id)) this.foodCache.delete(id);
    }
    return out;
  }
}

/**
 * `cloneWorld` that shares the pellet objects instead of copying them. The engine creates a
 * pellet once and never changes it (it only adds and removes them), so keyframes can hold
 * the same objects; ~1 000 pellets are most of a world, and each is now stored once.
 */
function copyWorld(world: World): World {
  const copy = cloneWorld({ ...world, food: [] });
  copy.food = world.food.slice();
  return copy;
}

function newChunk(start: number, keyframe: World): Chunk {
  const cap = 256;
  return {
    start,
    keyframe,
    ids: [],
    entry: [],
    turns: new Float64Array(cap),
    boosts: new Uint8Array(cap),
    truncated: new Uint8Array(cap),
    logs: [],
    spawns: [],
    deaths: [],
  };
}

function reserve(chunk: Chunk, size: number): void {
  if (size <= chunk.turns.length) return;
  const cap = Math.max(size, chunk.turns.length * 2);
  const grow = <T extends Float64Array | Uint8Array>(a: T, make: (n: number) => T): T => {
    const b = make(cap);
    b.set(a);
    return b;
  };
  chunk.turns = grow(chunk.turns, (n) => new Float64Array(n));
  chunk.boosts = grow(chunk.boosts, (n) => new Uint8Array(n));
  chunk.truncated = grow(chunk.truncated, (n) => new Uint8Array(n));
}

function traceAt(chunk: Chunk, e: number): BotTrace {
  const lines = unpackLog(chunk.logs[e]);
  return {
    action: { turn: chunk.turns[e] as number, boost: chunk.boosts[e] === 1 },
    logs: lines,
    logTruncated: chunk.truncated[e] === 1,
  };
}

function packLog(lines: readonly string[]): StoredLog {
  if (lines.length === 0) return undefined;
  if (lines.some((l) => l.includes("\n"))) return lines;
  return lines.join("\n");
}

const NO_LINES: readonly string[] = [];

function unpackLog(log: StoredLog): readonly string[] {
  if (log === undefined) return NO_LINES;
  return typeof log === "string" ? log.split("\n") : log;
}

function runBot(slot: Slot, snake: Snake, world: World): Action {
  try {
    return slot.bot.act(snake, world, slot.log.log);
  } catch (e) {
    slot.log.log(`error: ${e instanceof Error ? e.message : String(e)}`);
    return { turn: 0 };
  }
}
