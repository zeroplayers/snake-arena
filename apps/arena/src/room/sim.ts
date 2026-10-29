/**
 * The simulation half of a room: the engine world, its replay recorder and one life per snake (a
 * sandbox life per deployed version, a native one per house bot, `house-life.ts`). No storage or
 * network here; `RoomDO` loads it, runs batches and saves the result.
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
import { type BotLife, DEFAULT_OP_BUDGET, type TickReport, WORK_PER_OP } from "@zerosnake/sandbox";
import { type BotInfo, type BotState, LOG_LIMIT_BYTES } from "@zerosnake/sdk";
import { type SimLife, startHouseLife } from "./house-life.ts";
import type { LifeEntry, RosterEntry } from "./store.ts";
import { type TraceChange, TraceRecorder } from "./trace.ts";

/** R2 key (REPLAYS) of a room's replay chunk that starts at `tick`. */
export function chunkKey(roomId: string, tick: number): string {
  return `${roomId}/${String(tick).padStart(10, "0")}.zsr`;
}

export interface EndedLife {
  entry: RosterEntry;
  death: Death;
  /** The killer's entry, when the killer was a snake of this room. */
  killer: RosterEntry | null;
  /** Start tick of the replay chunk that recorded the death. */
  chunkTick: number;
  /** The life's trace (`trace.ts`); null for house bots. */
  trace: TraceRecorder | null;
}

/** Watch mode's hooks (see `backstop.ts`). Normal batches pass none and never await. */
export interface BatchHooks {
  /**
   * Awaited before any bot code of `lifeId` runs: starting its life (`init`) or its tick at
   * `tick`. `abort` abandons the tick in progress and ends the batch.
   */
  beforeBot?: (lifeId: string, kind: "init" | "tick", tick: number) => Promise<"go" | "abort">;
  /** Awaited after each bot call returned. */
  afterBot?: () => Promise<void>;
  /**
   * Restart resumed bots in random order (spawns keep theirs). Which bot starts first doesn't
   * change the world; it only moves each bot's start to a different point of the batch.
   */
  shuffleStarts?: boolean;
  /** Asked between ticks; false ends the batch early. */
  continueBatch?: () => boolean;
  /** Called after each engine step with the new frame (spectators, `spectators.ts`). Sync. */
  afterStep?: (world: World) => void;
}

/** What a room starts its bots with: a sandbox and the room's bundles (`bundles.ts`). */
export interface LifeStarter {
  /**
   * Host work for the bundles of every life in the room (`sources`, instrumenting them), run
   * before any bot call so that watch mode doesn't time it as one.
   */
  prepare(sources: string[]): Promise<void>;
  startLife(source: string, info: BotInfo): BotLife;
}

export interface BatchPlan {
  /** Lives to spawn before the first tick, in order. */
  spawns: LifeEntry[];
  /** Lives killed on the first tick without running their code (evicted, leaving). */
  faults: Map<string, Fault>;
  ticks: number;
}

export interface BatchResult {
  spawned: RosterEntry[];
  ended: EndedLife[];
  /** Replay chunks completed during the batch. */
  chunks: { key: string; tick: number; bytes: Uint8Array }[];
  /** Ticks actually stepped (fewer than planned when watch mode ended the batch early). */
  ticks: number;
  /** A tick was abandoned halfway: some bots ran it, the world didn't step. */
  aborted: boolean;
  /** Sandboxed bot ticks (house bots run natively and aren't counted). */
  botTicks: number;
  /** The sandbox's cost units of the bot ticks (`TickReport.work`), summed. */
  work: number;
}

interface Running {
  entry: RosterEntry;
  /** A sandbox life for a deployed version, a native one for a house bot. */
  life: SimLife | null;
  /** Real lives only (house bots aren't traced). */
  trace: TraceRecorder | null;
}

export class RoomSim {
  readonly recorder: ReplayRecorder;
  private readonly running = new Map<string, Running>();
  private chunks: { key: string; tick: number; bytes: Uint8Array }[] = [];

  /**
   * Resumes a room: `world` and `pending` as saved, `roster` the lives in it. Every bot starts a
   * fresh sandbox life (`init` again, empty memory): QuickJS heaps don't survive an eviction.
   * `traces` are the roster's saved traces (`trace-store.ts`).
   */
  constructor(
    readonly roomId: string,
    readonly world: World,
    pending: ReplayChunk | null,
    private readonly sandbox: LifeStarter,
    roster: RosterEntry[],
    chunkTicks?: number,
    traces: Record<string, TraceRecorder> = {},
  ) {
    this.recorder = new ReplayRecorder(world, {
      onChunk: (bytes, chunk) => {
        const tick = chunk.snapshot.tick;
        this.chunks.push({ key: chunkKey(roomId, tick), tick, bytes });
      },
      ...(pending ? { pending } : {}),
      ...(chunkTicks ? { chunkTicks } : {}),
    });
    for (const entry of roster) {
      this.running.set(entry.lifeId, { entry, life: null, trace: traces[entry.lifeId] ?? null });
    }
  }

  /** Lives in the room, spawn order. */
  get roster(): RosterEntry[] {
    return [...this.running.values()].map((r) => r.entry);
  }

  /** Lives whose bot will (re)start with the next batch, unless the plan kills them. */
  idleLifeIds(): string[] {
    return [...this.running.values()].filter((r) => !r.life).map((r) => r.entry.lifeId);
  }

  /** Start tick of the open replay chunk, or null. */
  get openChunkTick(): number | null {
    return this.recorder.pending?.snapshot.tick ?? null;
  }

  /** What changed in the running lives' traces since the last call, for the room to save. */
  traceChanges(): { lifeId: string; changes: TraceChange[] }[] {
    const out: { lifeId: string; changes: TraceChange[] }[] = [];
    for (const r of this.running.values()) {
      if (r.trace) out.push({ lifeId: r.entry.lifeId, changes: r.trace.changes() });
    }
    return out;
  }

  markLeaving(lifeId: string): void {
    const r = this.running.get(lifeId);
    if (r) r.entry.leaving = true;
  }

  /** Runs one batch: spawns, then up to `plan.ticks` engine steps, every bot's tick before each. */
  async run(plan: BatchPlan, hooks: BatchHooks = {}, now = Date.now()): Promise<BatchResult> {
    const world = this.world;
    const { beforeBot, afterBot, continueBatch, shuffleStarts, afterStep } = hooks;
    const result: BatchResult = {
      spawned: [],
      ended: [],
      chunks: [],
      ticks: 0,
      aborted: false,
      botTicks: 0,
      work: 0,
    };
    const finish = () => {
      result.chunks = this.chunks;
      this.chunks = [];
      return result;
    };

    // Bots that lost their sandbox life (a resumed room) start again.
    const resumed = [...this.running.values()].filter(
      (r) => !r.life && !plan.faults.has(r.entry.lifeId),
    );
    if (shuffleStarts) shuffle(resumed);
    // Instrument bundles before the first bot call is marked: it's host work, not the bot's.
    // House bots run natively: nothing to instrument, and the watch hooks skip their calls.
    await this.sandbox.prepare(
      [...[...this.running.values()].map((r) => r.entry), ...plan.spawns]
        .filter((e) => !e.house)
        .map((e) => e.source),
    );
    const watched = (e: LifeEntry) => !e.house;
    for (const r of resumed) {
      if (!watched(r.entry)) {
        r.life = this.startLife(r.entry);
        continue;
      }
      if (beforeBot) await beforeBot(r.entry.lifeId, "init", world.tick);
      const life = this.startSandboxLife(r.entry);
      r.life = life;
      if (afterBot) await afterBot();
      if (r.trace) r.trace.restart(world.tick, life);
      else r.trace = this.startTrace(r.entry, life);
    }
    for (const entry of plan.spawns) {
      this.recorder.spawn({ id: entry.lifeId, author: entry.author });
      const spawned: RosterEntry = {
        ...entry,
        startTick: world.tick,
        startedAt: now,
        leaving: false,
        evicted: false,
      };
      const r: Running = { entry: spawned, life: null, trace: null };
      this.running.set(entry.lifeId, r);
      result.spawned.push(spawned);
      if (!watched(entry)) {
        r.life = this.startLife(spawned);
        continue;
      }
      if (beforeBot) await beforeBot(entry.lifeId, "init", world.tick);
      const life = this.startSandboxLife(spawned);
      r.life = life;
      if (afterBot) await afterBot();
      r.trace = this.startTrace(spawned, life);
    }

    const ended = new Map<string, Running>();
    for (let k = 0; k < plan.ticks; k++) {
      if (k > 0 && continueBatch && !continueBatch()) break;
      const actions: Record<string, Action> = {};
      const faults: Record<string, Fault> = {};
      // Traced once the world steps: an abandoned tick never happened.
      const calls: { trace: TraceRecorder; seen: BotState; report: TickReport }[] = [];
      for (const snake of world.snakes) {
        const id = snake.id;
        const forced = k === 0 ? plan.faults.get(id) : undefined;
        const r = this.running.get(id);
        if (forced || !r?.life) {
          faults[id] = forced ?? "error";
          continue;
        }
        const sandboxed = watched(r.entry);
        if (sandboxed && beforeBot && (await beforeBot(id, "tick", world.tick)) === "abort") {
          result.aborted = true;
          return finish();
        }
        const seen = buildBotState(world, snake);
        const report = r.life.tick(seen);
        if (sandboxed) {
          if (afterBot) await afterBot();
          result.botTicks++;
          result.work += report.work;
        }
        if (r.trace) calls.push({ trace: r.trace, seen, report });
        actions[id] = report.action;
        if (report.death) faults[id] = report.death.fault;
      }
      this.recorder.step(actions, faults);
      result.ticks++;
      for (const c of calls) c.trace.record(c.seen, c.report);
      afterStep?.(world);
      const chunkTick = this.recorder.pending?.snapshot.tick ?? world.tick;
      for (const death of world.deaths) {
        const r = this.running.get(death.id);
        if (!r) continue;
        r.life?.dispose();
        r.life = null;
        this.running.delete(death.id);
        ended.set(death.id, r);
        const killerId = death.killerId;
        const killer = killerId ? (this.running.get(killerId) ?? ended.get(killerId)) : undefined;
        result.ended.push({
          entry: r.entry,
          death,
          killer: killer?.entry ?? null,
          chunkTick,
          trace: r.trace,
        });
      }
    }
    return finish();
  }

  /** Ends the open replay chunk (room shutting down). */
  flush(): { key: string; tick: number; bytes: Uint8Array }[] {
    this.recorder.flush();
    const chunks = this.chunks;
    this.chunks = [];
    return chunks;
  }

  dispose(): void {
    for (const r of this.running.values()) r.life?.dispose();
    this.running.clear();
  }

  /** A house bot's native life, or a deployed version's sandbox life. */
  private startLife(entry: RosterEntry): SimLife {
    return entry.house
      ? startHouseLife(entry.house, this.info(entry))
      : this.startSandboxLife(entry);
  }

  private startSandboxLife(entry: RosterEntry): BotLife {
    return this.sandbox.startLife(entry.source, this.info(entry));
  }

  /** What `init` gets: the same for a house bot as for a deployed one. */
  private info(entry: RosterEntry): BotInfo {
    const snake = this.world.snakes.find((s) => s.id === entry.lifeId);
    if (!snake) throw new Error(`life ${entry.lifeId} has no snake`);
    return buildBotInfo(this.world, snake, {
      opBudget: DEFAULT_OP_BUDGET,
      logLimitBytes: LOG_LIMIT_BYTES,
    });
  }

  private startTrace(entry: RosterEntry, life: BotLife): TraceRecorder | null {
    if (!entry.versionId) return null;
    return TraceRecorder.start(
      {
        lifeId: entry.lifeId,
        versionId: entry.versionId,
        roomId: this.roomId,
        startTick: entry.startTick,
        budget: {
          ops: DEFAULT_OP_BUDGET,
          work: DEFAULT_OP_BUDGET * WORK_PER_OP,
          logBytes: LOG_LIMIT_BYTES,
        },
      },
      life,
    );
  }
}

function shuffle<T>(items: T[]): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j] as T, items[i] as T];
  }
}
