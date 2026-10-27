/**
 * A suspect's trial (see `backstop.ts`): only its code runs, in a sandbox of its own, and nothing
 * else of the room runs in the same invocation, so whatever the invocation spends is the suspect's.
 *
 * 1. **Rebuild**: its sandbox life starts where the real one did (`botStartTick`: its spawn or the
 *    reload that last restarted it) and gets the exact recorded states from the replay chunks up to
 *    the saved frame. Bots are deterministic (seeded `Math.random`, no clock), so its memory ends
 *    up as it was in the room.
 * 2. **Live**: from the saved frame, the ticks nobody recorded (the batch that died, or the next
 *    ticks for a slow trial), with the other snakes going straight.
 *
 * A long rebuild is split over invocations (`run` yields when told to); the trial is in memory
 * meanwhile, and starts over if the object is evicted.
 */
import {
  type ActionMap,
  buildBotInfo,
  buildBotState,
  cloneWorld,
  type Fault,
  ReplayPlayer,
  spawnSnake,
  step,
  type World,
} from "@zerosnake/engine";
import { type BotLife, DEFAULT_OP_BUDGET, type Sandbox } from "@zerosnake/sandbox";
import { LOG_LIMIT_BYTES } from "@zerosnake/sdk";
import { botSource } from "./sim.ts";
import type { LifeEntry } from "./store.ts";

export interface TrialSetup {
  suspect: LifeEntry;
  sandbox: Sandbox;
  /** Where the suspect's sandbox life began. */
  startTick: number;
  /** Consecutive recorded chunks covering `startTick` up to the saved frame (null if equal). */
  chunks: Uint8Array[] | null;
  /** The room's saved world (not modified). */
  saved: World;
  /** Live part: snakes spawned on the saved frame first, faults of its first tick, length. */
  spawns: LifeEntry[];
  faults: ReadonlyMap<string, Fault>;
  liveTicks: number;
}

export interface TrialHooks {
  /** `call`: `init@<tick>` or `tick@<tick>`. */
  before: (call: string) => Promise<number>;
  after: () => Promise<number>;
}

export interface TrialOutcome {
  /** The suspect wasn't alive for the whole trial (it died, or wasn't there). */
  gone: boolean;
  /** Live ticks run. */
  ran: number;
  /** Measured duration of each live tick call (an upper bound on its CPU, plus one sync). */
  tickMs: number[];
}

export class TrialRunner {
  private readonly player: ReplayPlayer | null;
  private world: World;
  private life: BotLife | null = null;
  private live = false;
  private liveLeft = 0;
  private firstFaults: Record<string, Fault> = {};
  private readonly out: TrialOutcome = { gone: false, ran: 0, tickMs: [] };

  constructor(private readonly setup: TrialSetup) {
    if (setup.chunks && setup.startTick < setup.saved.tick) {
      this.player = new ReplayPlayer(setup.chunks);
      this.world = this.player.seek(setup.startTick);
    } else {
      this.player = null;
      this.world = this.goLive();
    }
  }

  /**
   * Runs until the trial ends ("done": see `outcome`) or `yieldNow()` asks to stop ("yield"; call
   * again in a later invocation). Around each of the suspect's calls, `hooks.before(call)` makes
   * "running this call" durable and `hooks.after()` makes "between calls" durable; both return a fresh
   * clock. `after` may also wait, so a restart is likelier to land between calls.
   */
  async run(hooks: TrialHooks, yieldNow: () => boolean): Promise<"done" | "yield"> {
    const id = this.setup.suspect.lifeId;
    if (!this.life) {
      const snake = this.world.snakes.find((s) => s.id === id);
      if (!snake || (this.live && this.setup.faults.has(id))) return this.end(true);
      const info = buildBotInfo(this.world, snake, {
        opBudget: DEFAULT_OP_BUDGET,
        logLimitBytes: LOG_LIMIT_BYTES,
      });
      await hooks.before(`init@${this.world.tick}`);
      this.life = this.setup.sandbox.startLife(botSource(this.setup.suspect), info);
      await hooks.after();
    }
    for (;;) {
      if (yieldNow()) return "yield";
      const me = this.world.snakes.find((s) => s.id === id);
      if (!me) return this.end(true);
      if (!this.live) {
        // Rebuild: the recorded states, in order; the recorded actions move the world.
        const player = this.player as ReplayPlayer;
        if (player.tick >= this.setup.saved.tick) {
          this.world = this.goLive();
          continue;
        }
        const state = buildBotState(this.world, me);
        await hooks.before(`tick@${this.world.tick}`);
        this.life.tick(state);
        await hooks.after();
        this.world = player.next();
        continue;
      }
      if (this.liveLeft <= 0) return this.end(false);
      const state = buildBotState(this.world, me);
      const before = await hooks.before(`tick@${this.world.tick}`);
      const report = this.life.tick(state);
      this.out.ran++;
      const after = await hooks.after();
      this.out.tickMs.push(after - before);
      const actions: ActionMap = { [id]: report.action };
      const faults: Record<string, Fault> = { ...this.firstFaults };
      if (report.death) faults[id] = report.death.fault;
      step(this.world, actions, faults);
      this.firstFaults = {};
      this.liveLeft--;
    }
  }

  get outcome(): TrialOutcome {
    return this.out;
  }

  dispose(): void {
    this.life?.dispose();
    this.life = null;
  }

  private goLive(): World {
    const world = cloneWorld(this.setup.saved);
    for (const s of this.setup.spawns) spawnSnake(world, { id: s.lifeId, author: s.author });
    this.firstFaults = Object.fromEntries(this.setup.faults);
    this.live = true;
    this.liveLeft = this.setup.liveTicks;
    return world;
  }

  private end(gone: boolean): "done" {
    this.out.gone ||= gone;
    this.dispose();
    return "done";
  }
}
