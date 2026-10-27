/**
 * `MatchSource` over a recorded room replay (`ReplayPlayer` chunks from `REPLAYS`), so the site
 * can show it in `@zerosnake/viewer`.
 *
 * The constructor plays the whole replay once with `ReplayPlayer` (which checks the recorded
 * hashes): that finds every life and death, and keeps a world copy every `KEYFRAME_INTERVAL`
 * ticks and at each chunk start, plus each tick's recorded inputs. Any tick is then rebuilt by
 * stepping from the keyframe before it with those inputs, the same way `ReplayPlayer.next`
 * does. Keyframes sit on every chunk start, so a rebuild never crosses a chunk boundary.
 * Playing forward steps a cursor one tick at a time; a random seek costs at most one interval.
 *
 * Only types and `@zerosnake/viewer/food` come from the viewer, so this module doesn't pull in
 * three.js.
 */
import {
  type Action,
  cloneWorld,
  type Fault,
  type Food,
  ReplayDesyncError,
  ReplayPlayer,
  type ReplayTick,
  replayChunkInfo,
  spawnSnake,
  step,
  TICK_RATE,
  TURN_STEPS,
  type World,
} from "@zerosnake/engine";
import type { RenderFood, RenderSnake } from "@zerosnake/renderer";
import type {
  BotTrace,
  LifeInfo,
  MatchInfo,
  MatchSource,
  SnakeTick,
  TickSnapshot,
} from "@zerosnake/viewer";
import { foodDisplaySize } from "@zerosnake/viewer/food";
import type { TraceTick } from "../shared/trace";

export const KEYFRAME_INTERVAL = 100;
/** Used when the recorded config has no `visionRadius`. Same as the viewer's default. */
export const FALLBACK_VISION_RADIUS = 30;
const SNAPSHOT_CACHE = 32;

/** How a life is shown: who drives it and in which colour. */
export interface LifeLabel {
  bot: string;
  author: string;
  /** `#rrggbb`. */
  color: string;
}

export interface ReplaySourceOptions {
  title?: string;
  /**
   * Names a snake found in the replay. `index` counts lives in order of appearance, for
   * picking a palette colour. Default: the snake id as the bot, the recorded author.
   */
  label?: (snake: { id: string; author: string }, index: number) => LifeLabel;
}

type MutableLife = { -readonly [K in keyof LifeInfo]: LifeInfo[K] };

const NO_DEATHS: readonly string[] = [];

export class ReplaySource implements MatchSource {
  readonly info: MatchInfo;
  readonly firstTick: number;
  readonly lastTick: number;
  readonly endTick: number;
  /**
   * Set when the recorded hashes didn't match this engine (a replay from an older engine
   * version): it still plays, but may not show what really happened.
   */
  readonly desync: ReplayDesyncError | undefined;

  private readonly keyframes: { tick: number; world: World }[] = [];
  /** Inputs leading from tick `firstTick + k` to the next. */
  private readonly inputs: ReplayTick[] = [];
  /** Snake ids on tick `firstTick + k`, in world order (shared while unchanged). */
  private readonly ids: (readonly string[])[] = [];
  private readonly deathsAt = new Map<number, string[]>();
  private readonly lifeList: MutableLife[] = [];
  private readonly lifeById = new Map<string, MutableLife>();
  private readonly cache = new Map<number, TickSnapshot>();
  private readonly foodCache = new Map<number, RenderFood>();
  private cursor: { world: World; tick: number } | undefined;
  /** Recorded traces by life, then room tick (`setTrace`). */
  private readonly traces = new Map<string, Map<number, TraceTick>>();

  constructor(chunks: readonly Uint8Array[], options: ReplaySourceOptions = {}) {
    let desync: ReplayDesyncError | undefined;
    let player: ReplayPlayer;
    try {
      player = this.scan(chunks, true, options);
    } catch (e) {
      if (!(e instanceof ReplayDesyncError)) throw e;
      desync = e;
      this.reset();
      player = this.scan(chunks, false, options);
    }
    this.desync = desync;
    this.firstTick = player.startTick;
    this.lastTick = player.endTick;
    this.endTick = player.endTick;
    const config = (this.keyframes[0] as { world: World }).world.config;
    this.info = {
      tps: TICK_RATE,
      arenaHalfSize: config.arenaHalfSize,
      visionRadius: (config as { visionRadius?: number }).visionRadius ?? FALLBACK_VISION_RADIUS,
      ...(options.title !== undefined && { title: options.title }),
    };
  }

  /** Everything is decoded up front. */
  request(): void {}

  snapshot(tick: number): TickSnapshot | undefined {
    if (!Number.isInteger(tick) || tick < this.firstTick || tick > this.lastTick) return undefined;
    const hit = this.cache.get(tick);
    if (hit) {
      this.cache.delete(tick);
      this.cache.set(tick, hit);
      return hit;
    }
    const snap = this.build(this.worldAt(tick));
    this.cache.set(tick, snap);
    if (this.cache.size > SNAPSHOT_CACHE) {
      this.cache.delete(this.cache.keys().next().value as number);
    }
    return snap;
  }

  trace(id: string, tick: number): BotTrace | undefined {
    const k = tick - this.firstTick;
    const i = this.ids[k]?.indexOf(id) ?? -1;
    const input = this.inputs[k];
    if (i < 0 || !input) return undefined;
    const recorded = this.traces.get(id)?.get(tick);
    if (!recorded) return { action: actionAt(input, i) };
    return {
      action: actionAt(input, i),
      logs: recorded.log,
      ops: recorded.ops,
      ...(recorded.logCut && { logTruncated: true }),
    };
  }

  /**
   * Adds what a life's bot logged and spent (its trace, which only its owner gets), so the
   * viewer's log panel shows it. Ticks the trace downsampled away have no logs.
   */
  setTrace(lifeId: string, ticks: readonly TraceTick[]): void {
    this.traces.set(lifeId, new Map(ticks.map((t) => [t.tick, t])));
  }

  lives(): readonly LifeInfo[] {
    return this.lifeList;
  }

  life(id: string): LifeInfo | undefined {
    return this.lifeById.get(id);
  }

  dispose(): void {
    this.cache.clear();
    this.cursor = undefined;
  }

  private reset(): void {
    this.keyframes.length = 0;
    this.inputs.length = 0;
    this.ids.length = 0;
    this.deathsAt.clear();
    this.lifeList.length = 0;
    this.lifeById.clear();
  }

  /** Plays the replay once, recording keyframes, inputs, lives and deaths. */
  private scan(
    chunks: readonly Uint8Array[],
    verify: boolean,
    options: ReplaySourceOptions,
  ): ReplayPlayer {
    const player = new ReplayPlayer(chunks, { verify });
    const chunkStarts = new Set(chunks.map((c) => replayChunkInfo(c).startTick));
    const label =
      options.label ?? ((s: { id: string; author: string }) => defaultLabel(s.id, s.author));
    let lastIds: readonly string[] = [];
    let world = player.seek(player.startTick);
    for (;;) {
      const tick = world.tick;
      const k = tick - player.startTick;
      if (k % KEYFRAME_INTERVAL === 0 || chunkStarts.has(tick)) {
        this.keyframes.push({ tick, world: copyWorld(world) });
      }
      for (const snake of world.snakes) {
        if (this.lifeById.has(snake.id)) continue;
        const { bot, author, color } = label(snake, this.lifeList.length);
        const life: MutableLife = { id: snake.id, bot, author, color, bornTick: snake.bornTick };
        this.lifeList.push(life);
        this.lifeById.set(snake.id, life);
      }
      const same =
        world.snakes.length === lastIds.length && world.snakes.every((s, i) => s.id === lastIds[i]);
      if (!same) lastIds = world.snakes.map((s) => s.id);
      this.ids[k] = lastIds;

      const input = player.inputs();
      if (!input) break;
      this.inputs[k] = input;
      world = player.next();
      if (world.deaths.length > 0) {
        this.deathsAt.set(
          world.tick,
          world.deaths.map((d) => d.id),
        );
      }
      for (const d of world.deaths) {
        const life = this.lifeById.get(d.id);
        if (!life) continue;
        life.death = {
          tick: d.tick,
          cause: d.cause,
          killerId: d.killerId,
          score: d.score,
          mass: d.mass,
          kills: d.kills,
        };
      }
    }
    return player;
  }

  /** The frame at `tick`, rebuilt from the keyframe at or before it. */
  private worldAt(tick: number): World {
    let c = this.cursor;
    const key = this.keyframeFor(tick);
    if (!c || c.tick > tick || c.tick < key.tick) {
      c = { world: copyWorld(key.world), tick: key.tick };
      this.cursor = c;
    }
    while (c.tick < tick) {
      const input = this.inputs[c.tick - this.firstTick] as ReplayTick;
      step(c.world, actionMap(c.world, input), faultMap(c.world, input));
      for (const s of input.spawns) spawnSnake(c.world, s);
      c.tick++;
    }
    return c.world;
  }

  private keyframeFor(tick: number) {
    const frames = this.keyframes;
    let lo = 0;
    let hi = frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((frames[mid] as { tick: number }).tick <= tick) lo = mid;
      else hi = mid - 1;
    }
    return frames[lo] as { tick: number; world: World };
  }

  private build(world: World): TickSnapshot {
    const tick = world.tick;
    const k = tick - this.firstTick;
    const input = this.inputs[k];
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
        ...(input && { action: actionAt(input, i) }),
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
        food: this.renderFood(world),
      },
      snakes,
      deaths: this.deathsAt.get(tick) ?? NO_DEATHS,
    };
  }

  /** Pellets never move, so each one is mapped once and shared by the snapshots holding it. */
  private renderFood(world: World): RenderFood[] {
    const c = world.config;
    const out: RenderFood[] = [];
    for (const f of world.food) {
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
    return out;
  }
}

const FALLBACK_COLORS = ["#00ff1a", "#00b2ff", "#ff0080", "#ffd600", "#7b00ff", "#00fff2"];

/** A stable colour per snake id when the caller doesn't pick one. */
function defaultLabel(id: string, author: string): LifeLabel {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return { bot: id, author, color: FALLBACK_COLORS[h % FALLBACK_COLORS.length] as string };
}

function actionAt(input: ReplayTick, i: number): Action {
  return { turn: (input.turns[i] ?? 0) / TURN_STEPS, boost: input.boosts[i] === true };
}

function actionMap(world: World, input: ReplayTick): Record<string, Action> {
  const actions: Record<string, Action> = {};
  world.snakes.forEach((s, i) => {
    actions[s.id] = actionAt(input, i);
  });
  return actions;
}

function faultMap(world: World, input: ReplayTick): Record<string, Fault> {
  const faults: Record<string, Fault> = {};
  for (const f of input.faults) {
    const s = world.snakes[f.index];
    if (s) faults[s.id] = f.fault;
  }
  return faults;
}

/**
 * `cloneWorld` sharing pellet objects: the engine never changes a pellet once created, and
 * they are most of a world.
 */
function copyWorld(world: World): World {
  const food: Food[] = world.food.slice();
  const copy = cloneWorld({ ...world, food: [] });
  copy.food = food;
  return copy;
}
