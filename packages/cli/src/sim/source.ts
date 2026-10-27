import { type Food, ReplayPlayer, type World } from "@zerosnake/engine";
import { type RenderFood, type RenderSnake, SNAKE_PALETTE } from "@zerosnake/renderer";
import type {
  BotTrace,
  LifeInfo,
  MatchInfo,
  MatchSource,
  SnakeTick,
  TickSnapshot,
} from "@zerosnake/viewer";
import type { SimChunk, SimLife, SnakeCall, TickCalls } from "./protocol.ts";

/** Built snapshots kept around: playback reads a few neighbouring ticks every frame. */
const SNAPSHOT_CACHE = 32;
const NO_DEATHS: readonly string[] = [];
const NO_LINES: readonly string[] = [];

type ViewerLife = LifeInfo & Pick<SimLife, "you">;

/**
 * A match recorded by `zerosnake sim` (sandboxed bots, run in Node), played back in the viewer.
 * The world comes from engine replay chunks re-simulated with `ReplayPlayer`; bot calls (ops,
 * logs, actions) and lives come alongside. Chunks arrive while the match is still running
 * (`append`), so `lastTick` grows until `finish()`.
 */
export class RecordedMatchSource implements MatchSource {
  readonly info: MatchInfo;
  endTick: number | undefined = undefined;

  private readonly chunks: Uint8Array[] = [];
  /** Calls of every recorded tick, from `firstTick`. */
  private readonly calls: TickCalls[] = [];
  private player: ReplayPlayer | null = null;
  private readonly colors = new Map<string, string>();
  private lifeList: ViewerLife[] = [];
  private lifeById = new Map<string, ViewerLife>();
  private deathsByTick = new Map<number, string[]>();
  private readonly cache = new Map<number, TickSnapshot>();
  private readonly foodCache = new Map<number, RenderFood>();

  constructor(info: MatchInfo, bots: readonly string[]) {
    this.info = info;
    bots.forEach((bot, i) => {
      this.colors.set(bot, SNAKE_PALETTE[i % SNAKE_PALETTE.length] as string);
    });
  }

  /** Chunks received so far; the next request asks for the ones after. */
  get chunkCount(): number {
    return this.chunks.length;
  }

  get firstTick(): number {
    return this.player?.startTick ?? 0;
  }

  get lastTick(): number {
    return this.player?.endTick ?? 0;
  }

  /** Adds the next chunks (in order) and replaces the list of lives. */
  append(chunks: readonly SimChunk[], lives: readonly SimLife[]): void {
    for (const c of chunks) {
      this.chunks.push(c.bytes);
      this.calls.push(...c.calls);
    }
    if (chunks.length > 0) this.player = new ReplayPlayer(this.chunks);
    this.setLives(lives);
    // The last snapshot was built before its tick's calls were known.
    this.cache.clear();
  }

  /** No more chunks will come. */
  finish(): void {
    this.endTick = this.lastTick;
  }

  /** Lives arrive with the chunks; ticks don't need asking for. */
  request(_tick: number): void {}

  snapshot(tick: number): TickSnapshot | undefined {
    const player = this.player;
    if (!player || !Number.isInteger(tick) || tick < this.firstTick || tick > this.lastTick) {
      return undefined;
    }
    const hit = this.cache.get(tick);
    if (hit) {
      // Refresh its place in the LRU order.
      this.cache.delete(tick);
      this.cache.set(tick, hit);
      return hit;
    }
    const snap = this.build(player.seek(tick));
    this.cache.set(tick, snap);
    if (this.cache.size > SNAPSHOT_CACHE) {
      this.cache.delete(this.cache.keys().next().value as number);
    }
    return snap;
  }

  trace(id: string, tick: number): BotTrace | undefined {
    const call = this.calls[tick - this.firstTick]?.[id];
    return call && toTrace(call);
  }

  lives(): readonly LifeInfo[] {
    return this.lifeList;
  }

  life(id: string): LifeInfo | undefined {
    return this.lifeById.get(id);
  }

  private setLives(lives: readonly SimLife[]): void {
    // Lives spawned after the last recorded tick would be listed before their snake exists.
    const known = lives.filter((l) => l.bornTick <= this.lastTick);
    this.lifeList = known.map((l) => ({
      ...l,
      color: this.colors.get(l.bot) ?? (SNAKE_PALETTE[0] as string),
    }));
    this.lifeById = new Map(this.lifeList.map((l) => [l.id, l]));
    this.deathsByTick = new Map();
    for (const l of known) {
      if (!l.death) continue;
      const list = this.deathsByTick.get(l.death.tick) ?? [];
      list.push(l.id);
      this.deathsByTick.set(l.death.tick, list);
    }
  }

  private build(world: World): TickSnapshot {
    const tick = world.tick;
    const calls = this.calls[tick - this.firstTick];
    const snakes: SnakeTick[] = [];
    const renderSnakes: RenderSnake[] = [];
    for (const snake of world.snakes) {
      const life = this.lifeById.get(snake.id);
      const call = calls?.[snake.id];
      snakes.push({
        id: snake.id,
        score: snake.score,
        mass: snake.mass,
        segments: snake.segments.length,
        kills: snake.kills,
        lifeTick: snake.lifeTick,
        boosting: snake.boosting,
        ...(call && toTrace(call)),
      });
      renderSnakes.push({
        id: snake.id,
        segments: snake.segments.map((p) => ({ x: p.x, y: p.y })),
        angle: snake.angle,
        length: snake.mass,
        radius: snake.size / 2,
        ...(life && { skin: { color: life.color } }),
      });
    }
    return {
      tick,
      frame: {
        tick,
        arenaHalfSize: world.config.arenaHalfSize,
        snakes: renderSnakes,
        food: this.renderFood(world),
      },
      snakes,
      deaths: this.deathsByTick.get(tick) ?? NO_DEATHS,
    };
  }

  /** Pellets never move, so each one is mapped once and shared by the snapshots holding it. */
  private renderFood(world: World): RenderFood[] {
    const c = world.config;
    const food: readonly Food[] = world.food;
    const out: RenderFood[] = [];
    for (const f of food) {
      let r = this.foodCache.get(f.id);
      if (!r) {
        r = {
          id: f.id,
          x: f.x,
          y: f.y,
          size: f.kind === "remains" ? c.remainsRadius : c.foodRadius,
        };
        this.foodCache.set(f.id, r);
      }
      out.push(r);
    }
    // Ids only grow; keep the cache to pellets that can still exist.
    if (this.foodCache.size > 4 * Math.max(64, food.length)) {
      const alive = new Set(food.map((f) => f.id));
      for (const id of this.foodCache.keys()) if (!alive.has(id)) this.foodCache.delete(id);
    }
    return out;
  }
}

function toTrace(call: SnakeCall): BotTrace {
  return {
    action: { turn: call.a, boost: call.b === 1 },
    logs: call.l ?? NO_LINES,
    logTruncated: call.t === 1,
    ...(call.o !== undefined && { ops: call.o }),
  };
}
