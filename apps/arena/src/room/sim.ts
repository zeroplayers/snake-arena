/**
 * The simulation half of a room: the engine world, its replay recorder and one sandbox life per
 * snake. No storage or network here; `RoomDO` loads it, runs batches and saves the result.
 */
import {
  type Action,
  buildBotInfo,
  buildBotState,
  type Death,
  type Fault,
  type ReplayChunk,
  ReplayRecorder,
  type World,
} from "@zerosnake/engine";
import { type BotLife, DEFAULT_OP_BUDGET, type Sandbox } from "@zerosnake/sandbox";
import { LOG_LIMIT_BYTES } from "@zerosnake/sdk";
import { HOUSE_BUNDLES } from "../house-bundles.gen.ts";
import type { LifeEntry, RosterEntry } from "./store.ts";

/** R2 key (REPLAYS) of a room's replay chunk that starts at `tick`. */
export function chunkKey(roomId: string, tick: number): string {
  return `${roomId}/${String(tick).padStart(10, "0")}.zsr`;
}

export interface EndedLife {
  entry: RosterEntry;
  death: Death;
  /** The killer's entry, when the killer was a snake of this room. */
  killer: RosterEntry | null;
}

export interface BatchHooks {
  /**
   * Called before any bot code of `lifeId` runs (its start or its tick at `tick`), and with null
   * before the engine step. The backstop uses it to leave a durable trace of who was running.
   */
  beforeBot?: (lifeId: string | null, tick: number) => Promise<void>;
}

export interface BatchPlan {
  /** Lives to spawn before the first tick, in order. */
  spawns: LifeEntry[];
  /** Lives killed on the first tick without running their code (banned, leaving). */
  faults: Map<string, Fault>;
  ticks: number;
}

export interface BatchResult {
  spawned: RosterEntry[];
  ended: EndedLife[];
  /** Replay chunks completed during the batch. */
  chunks: { key: string; bytes: Uint8Array }[];
  botTicks: number;
}

interface Running {
  entry: RosterEntry;
  life: BotLife | null;
}

export class RoomSim {
  readonly recorder: ReplayRecorder;
  private readonly running = new Map<string, Running>();
  private chunks: { key: string; bytes: Uint8Array }[] = [];

  /**
   * Resumes a room: `world` and `pending` as saved, `roster` the lives in it. Every bot starts a
   * fresh sandbox life (`init` again, empty memory): QuickJS heaps don't survive an eviction.
   */
  constructor(
    readonly roomId: string,
    readonly world: World,
    pending: ReplayChunk | null,
    private readonly sandbox: Sandbox,
    roster: RosterEntry[],
  ) {
    this.recorder = new ReplayRecorder(world, {
      onChunk: (bytes, chunk) => {
        this.chunks.push({ key: chunkKey(roomId, chunk.snapshot.tick), bytes });
      },
      ...(pending ? { pending } : {}),
    });
    for (const entry of roster) this.running.set(entry.lifeId, { entry, life: null });
  }

  /** Lives in the room, spawn order. */
  get roster(): RosterEntry[] {
    return [...this.running.values()].map((r) => r.entry);
  }

  /** Lives in the room whose bot isn't running (a resumed room): they start with the batch. */
  get idleLives(): number {
    let n = 0;
    for (const r of this.running.values()) if (!r.life) n++;
    return n;
  }

  markLeaving(lifeId: string): void {
    const r = this.running.get(lifeId);
    if (r) r.entry.leaving = true;
  }

  /** Runs one batch: spawns, then `plan.ticks` engine steps with every bot's tick before each. */
  async run(plan: BatchPlan, hooks: BatchHooks = {}, now = Date.now()): Promise<BatchResult> {
    const world = this.world;
    const beforeBot = hooks.beforeBot;
    const result: BatchResult = { spawned: [], ended: [], chunks: [], botTicks: 0 };

    // Bots that lost their sandbox life (a resumed room) start again.
    for (const r of this.running.values()) {
      if (r.life || plan.faults.has(r.entry.lifeId)) continue;
      if (beforeBot) await beforeBot(r.entry.lifeId, world.tick);
      r.life = this.startLife(r.entry);
    }
    for (const entry of plan.spawns) {
      this.recorder.spawn({ id: entry.lifeId, author: entry.author });
      const pendingChunk = this.recorder.pending as ReplayChunk;
      const spawned: RosterEntry = {
        ...entry,
        startTick: world.tick,
        startedAt: now,
        replayKey: chunkKey(this.roomId, pendingChunk.snapshot.tick),
        leaving: false,
      };
      const r: Running = { entry: spawned, life: null };
      this.running.set(entry.lifeId, r);
      result.spawned.push(spawned);
      if (beforeBot) await beforeBot(entry.lifeId, world.tick);
      r.life = this.startLife(spawned);
    }

    const ended = new Map<string, Running>();
    for (let k = 0; k < plan.ticks; k++) {
      const actions: Record<string, Action> = {};
      const faults: Record<string, Fault> = {};
      for (const snake of world.snakes) {
        const id = snake.id;
        const forced = k === 0 ? plan.faults.get(id) : undefined;
        const r = this.running.get(id);
        if (forced || !r?.life) {
          faults[id] = forced ?? "error";
          continue;
        }
        const state = buildBotState(world, snake);
        if (beforeBot) await beforeBot(id, world.tick);
        const report = r.life.tick(state);
        result.botTicks++;
        actions[id] = report.action;
        if (report.death) faults[id] = report.death.fault;
      }
      if (beforeBot) await beforeBot(null, world.tick);
      this.recorder.step(actions, faults);
      for (const death of world.deaths) {
        const r = this.running.get(death.id);
        if (!r) continue;
        r.life?.dispose();
        r.life = null;
        this.running.delete(death.id);
        ended.set(death.id, r);
        const killerId = death.killerId;
        const killer = killerId ? (this.running.get(killerId) ?? ended.get(killerId)) : undefined;
        result.ended.push({ entry: r.entry, death, killer: killer?.entry ?? null });
      }
    }
    result.chunks = this.chunks;
    this.chunks = [];
    return result;
  }

  /** Ends the open replay chunk (room shutting down). */
  flush(): { key: string; bytes: Uint8Array }[] {
    this.recorder.flush();
    const chunks = this.chunks;
    this.chunks = [];
    return chunks;
  }

  /** Mass and life tick of a living snake. */
  snake(lifeId: string): { lifeTick: number; mass: number } | null {
    const s = this.world.snakes.find((x) => x.id === lifeId);
    return s ? { lifeTick: s.lifeTick, mass: s.mass } : null;
  }

  dispose(): void {
    for (const r of this.running.values()) r.life?.dispose();
    this.running.clear();
  }

  private startLife(entry: RosterEntry): BotLife {
    const snake = this.world.snakes.find((s) => s.id === entry.lifeId);
    if (!snake) throw new Error(`life ${entry.lifeId} has no snake`);
    const source = entry.house ? (HOUSE_BUNDLES[entry.house] ?? "") : entry.source;
    const info = buildBotInfo(this.world, snake, {
      opBudget: DEFAULT_OP_BUDGET,
      logLimitBytes: LOG_LIMIT_BYTES,
    });
    return this.sandbox.startLife(source, info);
  }
}
