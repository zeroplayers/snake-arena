import {
  type Action,
  createWorld,
  type EngineConfig,
  type Food,
  type Snake,
  spawnSnake,
  step,
  TICK_RATE,
  type World,
} from "@zerosnake/engine";
import { type RenderFood, type RenderSnake, SNAKE_PALETTE } from "@zerosnake/renderer";
import { createTickLog, type LogFn, type TickLog } from "@zerosnake/sdk";
import type { LifeInfo, MatchInfo, MatchSource, SnakeTick, TickSnapshot } from "../types.ts";

/**
 * Placeholder until the engine defines vision (SPEC §3 "only a radius around the head"):
 * a bit under a third of the default arena radius.
 */
export const DEFAULT_VISION_RADIUS = 30;

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
  readonly visionRadius?: number;
  /** Ticks between a death and the bot's next life. Default 20. */
  readonly respawnDelay?: number;
  /** Snapshots kept for scrubbing; older ones are dropped. Default 18 000 (30 min at 10 tps). */
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

/** Evict in batches so a long match doesn't shift the array every tick. */
const EVICT_BATCH = 256;

/**
 * Runs the engine in the page, one tick per `request`ed tick, keeping every tick as a
 * snapshot so the viewer can scrub back. Bots act right after each tick is simulated, so a
 * snapshot carries the action and logs of the call that saw it.
 */
export class LiveEngineSource implements MatchSource {
  readonly info: MatchInfo;
  readonly endTick = undefined;
  readonly world: World;

  private readonly slots: Slot[];
  private readonly slotBySnake = new Map<string, Slot>();
  private readonly lifeList: MutableLife[] = [];
  private readonly lifeById = new Map<string, MutableLife>();
  private readonly snapshots: TickSnapshot[] = [];
  private readonly foodCache = new Map<number, RenderFood>();
  private readonly respawnDelay: number;
  private readonly maxTicks: number;
  private pending: Record<string, Action> = {};
  private offset = 0;

  constructor(options: LiveSourceOptions) {
    this.world = createWorld({
      seed: options.seed ?? 1,
      ...(options.config && { config: options.config }),
    });
    this.info = {
      tps: TICK_RATE,
      arenaRadius: this.world.config.arenaRadius,
      visionRadius: options.visionRadius ?? DEFAULT_VISION_RADIUS,
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
    this.spawnDue();
    this.record([]);
  }

  get firstTick(): number {
    return this.offset;
  }

  get lastTick(): number {
    return this.world.tick;
  }

  request(tick: number): void {
    while (this.world.tick < tick) this.advance();
  }

  snapshot(tick: number): TickSnapshot | undefined {
    if (!Number.isInteger(tick)) return undefined;
    return this.snapshots[tick - this.offset];
  }

  lives(): readonly LifeInfo[] {
    return this.lifeList;
  }

  life(id: string): LifeInfo | undefined {
    return this.lifeById.get(id);
  }

  private advance(): void {
    const world = step(this.world, this.pending);
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
    this.spawnDue();
    this.record(ended);
  }

  private spawnDue(): void {
    const world = this.world;
    for (const slot of this.slots) {
      if (slot.snakeId !== undefined || world.tick < slot.respawnAt) continue;
      slot.lives++;
      const id = `${slot.bot.name}#${slot.lives}`;
      const author = slot.bot.author ?? slot.bot.name;
      spawnSnake(world, { id, author });
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
  }

  /** Runs the bots on the current tick and stores it. */
  private record(deaths: readonly string[]): void {
    const world = this.world;
    const pending: Record<string, Action> = {};
    const snakes: SnakeTick[] = [];
    const renderSnakes: RenderSnake[] = [];

    for (const snake of world.snakes) {
      const slot = this.slotBySnake.get(snake.id);
      let action: Action | undefined;
      let logs: string[] | undefined;
      let logTruncated = false;
      if (slot) {
        action = runBot(slot, snake, world);
        const out = slot.log.flush();
        logs = out.lines;
        logTruncated = out.truncated;
        pending[snake.id] = action;
      }
      snakes.push({
        id: snake.id,
        score: snake.score,
        mass: snake.mass,
        segments: snake.segments.length,
        kills: snake.kills,
        lifeTick: snake.lifeTick,
        boosting: snake.boosting,
        ...(action && { action: { ...action } }),
        ...(logs && { logs, logTruncated }),
      });
      renderSnakes.push({
        id: snake.id,
        segments: snake.segments.map((p) => ({ x: p.x, y: p.y })),
        angle: snake.angle,
        length: snake.mass,
        radius: snake.size / 2,
        ...(slot && { skin: { color: slot.color } }),
      });
    }
    this.pending = pending;

    this.snapshots.push({
      tick: world.tick,
      frame: {
        tick: world.tick,
        arenaRadius: world.config.arenaRadius,
        snakes: renderSnakes,
        food: this.renderFood(world.food),
      },
      snakes,
      deaths,
    });
    if (this.snapshots.length > this.maxTicks + EVICT_BATCH) {
      const drop = this.snapshots.length - this.maxTicks;
      this.snapshots.splice(0, drop);
      this.offset += drop;
    }
  }

  /** Pellets never move, so each one is mapped once and shared by every snapshot holding it. */
  private renderFood(food: readonly Food[]): RenderFood[] {
    const c = this.world.config;
    const out: RenderFood[] = [];
    const alive = new Set<number>();
    for (const f of food) {
      alive.add(f.id);
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
    for (const id of this.foodCache.keys()) if (!alive.has(id)) this.foodCache.delete(id);
    return out;
  }
}

function runBot(slot: Slot, snake: Snake, world: World): Action {
  try {
    return slot.bot.act(snake, world, slot.log.log);
  } catch (e) {
    slot.log.log(`error: ${e instanceof Error ? e.message : String(e)}`);
    return { turn: 0 };
  }
}
