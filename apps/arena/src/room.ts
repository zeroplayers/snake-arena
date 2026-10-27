import { DurableObject } from "cloudflare:workers";
import {
  CHUNK_TICKS,
  createWorld,
  DEFAULT_CONFIG,
  decodeReplayChunk,
  encodeReplayChunk,
  type Fault,
  TICK_RATE,
  type World,
} from "@zerosnake/engine";
import { createSandbox } from "@zerosnake/sandbox";
// Wrangler only treats specifiers ending in .wasm as compiled modules; the package's "./wasm"
// export doesn't, so the file is imported by path.
import wasmModule from "../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm";
import { insertLives, recordBan } from "./db.ts";
import {
  batchTicks,
  DEFAULT_MAX_OUTBOX,
  DEFAULT_MAX_SNAKES,
  DEFAULT_MIN_AUTHORS,
  DO_CPU_LIMIT_MS,
  NEXT_LIFE_RETRY_MS,
  REALTIME_BATCH_TICKS,
  SAFETY_ALARM_MS,
} from "./limits.ts";
import type {
  BanRecord,
  IncidentOutcome,
  JoinResult,
  LifeResult,
  LifeTicket,
  MatchmakerRpc,
  RoomMode,
  RoomRpc,
  RoomStartOptions,
  RoomStatus,
} from "./protocol.ts";
import {
  DEFAULT_SLOW_TICK_MS,
  INCIDENT_WINDOW_MS,
  judgeCrash,
  judgeTrialCrash,
  retryDelayMs,
  SLOW_TICKS_TO_SUSPECT,
  SLOW_TRIAL_CONFIRM,
  SLOW_TRIAL_TICKS,
  STRIKES_TO_BAN,
  TRIAL_DEATHS_TO_CONFIRM,
  TRIAL_GAP_MS,
  TRIAL_JITTER_MS,
  TRIAL_MARGIN_TICKS,
  type Trial,
  WATCH_ABORT_SHARE,
  WATCH_STOP_SHARE,
  watching,
  watchWindow,
} from "./room/backstop.ts";
import { houseFill } from "./room/house.ts";
import {
  type BatchHooks,
  type BatchPlan,
  type BatchResult,
  chunkKey,
  RoomSim,
} from "./room/sim.ts";
import {
  type BatchMarker,
  type LifeEntry,
  type Meta,
  type PendingEntry,
  RoomStore,
  type RosterEntry,
} from "./room/store.ts";
import { TrialRunner } from "./room/trial.ts";

const TICK_MS = 1000 / TICK_RATE;

/**
 * One persistent room of up to 20 snakes (SPEC §4–5), simulated in batches of ticks from
 * `alarm()`: as fast as the CPU allows (`accelerated`) or at 10 ticks/s (`realtime`).
 *
 * A batch, step by step:
 *  1. plan: spawn the pending tickets (and house bots up to 5 distinct authors), kill banned and
 *     leaving lives; size the batch for the worst case (see `limits.ts`);
 *  2. write a marker with the invocation's start time and `sync()` it, so a batch that dies is
 *     noticed by the next alarm;
 *  3. run it (engine + one QuickJS life per snake, recorded by `ReplayRecorder`);
 *  4. in one transaction: save the world, the open replay chunk and the roster, queue the side
 *     effects (replay chunks for R2, finished lives for D1 and the matchmaker), clear the marker;
 *  5. deliver the outbox, ask the matchmaker for replacements, schedule the next alarm.
 *
 * Backstop (`room/backstop.ts`): a marker left over means the batch died. If too little wall time
 * passed for it to have been the CPU limit, it was a restart: the batch runs again and nobody is
 * blamed. Otherwise the room switches to watch mode (each bot call synced and timed, batches
 * stopped early) for a window that grows with repeated incidents. A crash in watch mode that only
 * one bot's own call can explain is a strike for that version; so is a life killed for ticks
 * measured far over budget. Two strikes ban the version.
 *
 * After any reload (eviction or crash) every bot restarts with `init` and empty memory; the
 * world, replay and roster continue exactly.
 */
export class RoomDO extends DurableObject<Env> implements RoomRpc {
  private readonly store: RoomStore;
  private sim: RoomSim | null = null;
  private busy = false;
  /** Watch mode: slow ticks measured per life (in memory; a reload starts the count again). */
  private readonly slowTicks = new Map<string, number>();
  /** A trial in progress over several invocations (lost on eviction: it starts over). */
  private trialRun: { key: string; runner: TrialRunner } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new RoomStore(ctx.storage);
  }

  // --- RPC ---------------------------------------------------------------------------------

  async start(options: RoomStartOptions = {}): Promise<RoomStatus> {
    if (!this.store.meta()) {
      const seed = options.seed ?? crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
      const world = createWorld({ seed });
      const limits = options.limits ?? {};
      const meta: Meta = {
        roomId: options.roomId ?? crypto.randomUUID(),
        state: "running",
        mode: options.mode ?? "accelerated",
        maxSnakes: options.maxSnakes ?? DEFAULT_MAX_SNAKES,
        minAuthors: options.minAuthors ?? DEFAULT_MIN_AUTHORS,
        manual: options.manual ?? false,
        limits: {
          cpuLimitMs: limits.cpuLimitMs ?? DO_CPU_LIMIT_MS,
          batchTicks: limits.batchTicks ?? 0,
          slowTickMs: limits.slowTickMs ?? DEFAULT_SLOW_TICK_MS,
          maxOutbox: limits.maxOutbox ?? DEFAULT_MAX_OUTBOX,
          chunkTicks: limits.chunkTicks ?? CHUNK_TICKS,
        },
        livesEnded: 0,
        lastBatchTicks: 0,
        nextLifeAfter: 0,
        realtimeNext: 0,
        watch: { untilTick: 0, untilMs: 0 },
        openChunkTick: null,
        trial: null,
      };
      this.store.transaction(() => {
        this.store.setMeta(meta);
        this.store.putJson("world", world);
        this.store.putBlob("chunk", null);
      });
    }
    return this.status();
  }

  async join(ticket: LifeTicket): Promise<JoinResult> {
    const meta = this.store.meta();
    if (meta?.state !== "running") return { ok: false, reason: "closed" };
    if (this.store.isBanned(ticket.versionId)) return { ok: false, reason: "banned" };
    const present = [...this.store.roster(), ...this.store.pending()];
    if (present.some((p) => p.lifeId === ticket.lifeId)) {
      return { ok: false, reason: "duplicate-life" };
    }
    if (present.some((p) => p.author === ticket.author)) {
      return { ok: false, reason: "author-present" };
    }
    if (present.length >= meta.maxSnakes) return { ok: false, reason: "full" };
    this.store.addPending({ ...ticket, house: null });
    await this.kick(meta);
    return { ok: true };
  }

  async leave(lifeId: string): Promise<boolean> {
    if (this.store.markLeaving(lifeId)) {
      this.sim?.markLeaving(lifeId);
      return true;
    }
    return this.store.removePendingLife(lifeId);
  }

  async setMode(mode: RoomMode): Promise<void> {
    const meta = this.store.updateMeta((m) => {
      if (m.mode === mode) return;
      m.mode = mode;
      m.realtimeNext = Date.now();
    });
    if (meta?.state !== "running" || meta.manual) return;
    // Switching to accelerated runs the next batch now; to real time, from now on.
    await this.ctx.storage.setAlarm(Date.now());
  }

  async status(): Promise<RoomStatus> {
    const meta = this.store.meta();
    const world = this.sim?.world ?? this.store.getJson<World>("world");
    const snakes = new Map((world?.snakes ?? []).map((s) => [s.id, s]));
    const outbox = this.store.outboxStats();
    return {
      roomId: meta?.roomId ?? null,
      state: meta ? meta.state : "new",
      mode: meta?.mode ?? "accelerated",
      tick: world?.tick ?? 0,
      snakes: this.store.roster().map((e) => ({
        lifeId: e.lifeId,
        versionId: e.versionId,
        author: e.author,
        house: e.house,
        lifeTick: snakes.get(e.lifeId)?.lifeTick ?? 0,
        mass: snakes.get(e.lifeId)?.mass ?? 0,
      })),
      pending: this.store.pending().map((p) => p.lifeId),
      lastBatchTicks: meta?.lastBatchTicks ?? 0,
      livesEnded: meta?.livesEnded ?? 0,
      incidents: this.store
        .incidents()
        .map(({ tick, outcome, versionId }) => ({ tick, outcome, versionId })),
      strikes: this.store
        .strikes()
        .map(({ versionId, lifeId, kind, tick }) => ({ versionId, lifeId, kind, tick })),
      bans: this.store.bans().map((b) => b.versionId),
      watching: meta ? watching(meta.watch, world?.tick ?? 0, Date.now()) : false,
      trial: meta?.trial ? { lifeId: meta.trial.lifeId, kind: meta.trial.kind } : null,
      outbox: { size: outbox.size, failing: outbox.failing },
      paused: meta ? outbox.size > meta.limits.maxOutbox : false,
    };
  }

  async runBatch(): Promise<RoomStatus> {
    await this.cycle();
    return this.status();
  }

  override async alarm(): Promise<void> {
    await this.cycle();
  }

  // --- The cycle ---------------------------------------------------------------------------

  private async cycle(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    // CPU time never exceeds wall time since this point: the backstop's evidence.
    const invokedAt = Date.now();
    try {
      const meta = this.store.meta();
      if (!meta) return;
      await this.drain();
      const outbox = this.store.outboxStats();
      if (meta.state !== "running") {
        if (outbox.size > 0) await this.scheduleRetry(meta, outbox.nextAt);
        return;
      }
      if (outbox.size > meta.limits.maxOutbox) {
        // D1/R2/matchmaker are failing: don't produce more until they recover.
        console.error("room paused, outbox full", meta.roomId, outbox);
        await this.scheduleRetry(meta, outbox.nextAt);
        return;
      }
      try {
        const marker = this.store.marker();
        if (marker?.phase === "trial") this.trialDied(meta, marker);
        else if (marker) await this.recover(meta, marker, invokedAt);
        else if (meta.trial) await this.trial(meta, meta.trial, invokedAt);
        else await this.batch(invokedAt);
      } catch (e) {
        // The in-memory room may be half a batch ahead of storage: drop it. The marker stays,
        // so the next cycle handles this like a batch that died.
        this.dropSim();
        throw e;
      }
      await this.drain();
      const queueEmpty = await this.refill();
      if (queueEmpty && !this.hasRealLives()) await this.close();
      else await this.scheduleNext();
    } finally {
      this.busy = false;
    }
  }

  private async batch(invokedAt: number): Promise<void> {
    const meta = this.store.meta();
    if (!meta) return;
    const sim = await this.loadSim(meta);
    const maxPendingSeq = this.store.lastPendingSeq();
    const plan = this.plan(meta, sim.roster, sim.world.tick, sim.idleLives, maxPendingSeq);
    const watch = watching(meta.watch, sim.world.tick, Date.now());
    const marker: BatchMarker = {
      phase: "batch",
      fromTick: sim.world.tick,
      maxPendingSeq,
      startedAt: invokedAt,
      watch,
      suspectLife: null,
      suspectAt: null,
      suspectTick: null,
      trialTick: null,
    };
    // Bots that restart now begin a new sandbox life here; a trial rebuilds them from this tick.
    this.store.setBotStart(
      sim.idleLifeIds().filter((id) => !plan.faults.has(id)),
      sim.world.tick,
    );
    await this.begin(meta, marker);
    const slow = { lifeId: null as string | null };
    const hooks = watch ? this.watchHooks(meta, marker, slow) : {};
    const result = await sim.run(plan, hooks);
    this.commit(sim, result, maxPendingSeq, () => {
      // Measured slow in watch mode: try it alone before anything else runs.
      const lifeId = slow.lifeId;
      const life = lifeId ? sim.roster.find((e) => e.lifeId === lifeId) : undefined;
      if (!lifeId || !life) return;
      this.slowTicks.delete(lifeId);
      this.store.updateMeta((m) => {
        m.trial ??= {
          kind: "slow",
          lifeId,
          untilTick: sim.world.tick,
          maxPendingSeq: 0,
          deaths: [],
          attempts: 0,
          reason: `${SLOW_TICKS_TO_SUSPECT} calls over ${meta.limits.slowTickMs} ms in watch mode`,
        };
      });
      this.store.addIncident({
        tick: sim.world.tick,
        outcome: "suspect",
        versionId: life.versionId,
        at: Date.now(),
      });
    });
    // Some bots ran a tick the world never stepped: restart them from the saved frame.
    if (result.aborted) this.dropSim();
  }

  /**
   * Watch mode: before each bot call, sync who is about to run and when; time each call (the
   * clock moves at I/O, so the time between two syncs bounds the CPU in between); stop the batch
   * before the invocation gets near the CPU limit, or when a bot was measured slow.
   */
  private watchHooks(meta: Meta, marker: BatchMarker, slow: { lifeId: string | null }): BatchHooks {
    const limit = meta.limits.cpuLimitMs;
    let last = Date.now();
    let lastLife: string | null = null;
    return {
      continueBatch: () =>
        slow.lifeId === null && Date.now() - marker.startedAt < WATCH_STOP_SHARE * limit,
      beforeBot: async (lifeId, tick) => {
        // Any I/O moves the clock; a timer is the cheapest.
        await new Promise((r) => setTimeout(r, 0));
        const now = Date.now();
        if (lastLife !== null && now - last > meta.limits.slowTickMs) {
          const n = (this.slowTicks.get(lastLife) ?? 0) + 1;
          this.slowTicks.set(lastLife, n);
          console.warn("room slow call", meta.roomId, lastLife, `${now - last} ms`, n);
          if (n >= SLOW_TICKS_TO_SUSPECT) slow.lifeId ??= lastLife;
        }
        if (lifeId !== null && now - marker.startedAt > WATCH_ABORT_SHARE * limit) return "abort";
        marker.suspectLife = lifeId;
        marker.suspectAt = now;
        marker.suspectTick = tick;
        this.store.setMarker(marker);
        await this.ctx.storage.sync();
        last = Date.now();
        lastLife = lifeId;
        return "go";
      },
    };
  }

  /** A batch died before saving its result (the marker is still there). */
  private async recover(meta: Meta, marker: BatchMarker, invokedAt: number): Promise<void> {
    this.dropSim();
    this.slowTicks.clear();
    const now = Date.now();
    const verdict = judgeCrash(marker, now, meta.limits.cpuLimitMs);
    const suspect = verdict.kind === "suspect" ? this.findLife(verdict.lifeId) : null;
    this.store.transaction(() => {
      this.store.clearMarker();
      this.store.addIncident({
        tick: marker.fromTick,
        outcome: verdict.kind,
        versionId: suspect?.versionId ?? null,
        at: now,
      });
      if (verdict.kind === "restart") return;
      const recent = this.store.cpuIncidentsSince(now - INCIDENT_WINDOW_MS);
      this.store.updateMeta((m) => {
        m.watch = watchWindow(m.watch, recent, marker.fromTick, now, DEFAULT_CONFIG.lifeCap);
        if (verdict.kind === "suspect" && suspect) {
          m.trial = {
            kind: "cpu",
            lifeId: suspect.lifeId,
            untilTick: marker.suspectTick ?? marker.fromTick,
            maxPendingSeq: marker.maxPendingSeq,
            deaths: [],
            attempts: 0,
            reason:
              `the room died ${Math.round(verdict.gapMs)} ms after its batch began, ` +
              `${Math.round(verdict.callMs)} ms into this bot's call`,
          };
        }
      });
    });
    console.error("room batch died", meta.roomId, verdict);
    // A suspect is tried alone first, in an invocation of its own.
    if (verdict.kind !== "suspect" || !suspect) await this.batch(invokedAt);
  }

  /**
   * The suspect's trial (`room/trial.ts`): only its code runs, rebuilt from the recorded states
   * since its sandbox life began, then through the unrecorded ticks. Long trials continue over
   * several invocations. Completing clears the suspect; a slow trial measures it.
   */
  private async trial(meta: Meta, trial: Trial, invokedAt: number): Promise<void> {
    const key = `${trial.lifeId}/${trial.attempts}`;
    if (this.trialRun?.key !== key) {
      this.trialRun?.runner.dispose();
      this.trialRun = null;
      const runner = await this.prepareTrial(meta, trial);
      if (typeof runner === "string") {
        this.endTrial(meta, trial, "inconclusive", runner);
        return;
      }
      this.trialRun = { key, runner };
    }
    const { runner } = this.trialRun;
    const limit = meta.limits.cpuLimitMs;
    await new Promise((r) => setTimeout(r, Math.random() * TRIAL_JITTER_MS));
    // CPU budget for this part of the trial (the jitter was wall time only).
    const started = Date.now();
    const marker: BatchMarker = {
      phase: "trial",
      fromTick: this.store.getJson<World>("world")?.tick ?? 0,
      maxPendingSeq: trial.maxPendingSeq,
      startedAt: invokedAt,
      watch: true,
      suspectLife: trial.lifeId,
      suspectAt: null,
      suspectTick: null,
      trialTick: null,
    };
    await this.begin(meta, marker);
    const mark = async (tick: number | null) => {
      marker.trialTick = tick;
      this.store.setMarker(marker);
      await this.ctx.storage.sync();
      return Date.now();
    };
    const step = await runner.run(
      {
        before: (tick) => mark(tick),
        after: async () => {
          const now = await mark(null);
          await new Promise((r) => setTimeout(r, Math.random() * TRIAL_GAP_MS));
          return now;
        },
      },
      // Wall time, sleeps included: a lower bound on how much CPU budget is left.
      () => Date.now() - started > WATCH_STOP_SHARE * limit,
    );
    if (step === "yield") {
      this.store.clearMarker();
      return;
    }
    this.trialRun = null;
    const out = runner.outcome;
    const slowTicks = out.tickMs.filter((ms) => ms > meta.limits.slowTickMs).length;
    console.warn("room trial", meta.roomId, trial.kind, trial.lifeId, out);
    if (out.gone) {
      this.endTrial(meta, trial, "inconclusive", "the suspect wasn't alive through the trial");
    } else if (trial.kind === "slow" && slowTicks >= SLOW_TRIAL_CONFIRM) {
      const detail =
        `${trial.reason}; run alone, ${slowTicks} of ${out.ran} ticks took over ` +
        `${meta.limits.slowTickMs} ms (slowest ${Math.max(...out.tickMs)} ms)`;
      this.endTrial(meta, trial, "slow", detail);
    } else this.endTrial(meta, trial, "cleared", "the trial completed");
  }

  /** Builds the trial's runner, or says why it can't be run. */
  private async prepareTrial(meta: Meta, trial: Trial): Promise<TrialRunner | string> {
    const saved = this.store.getJson<World>("world");
    const life = this.findLife(trial.lifeId);
    if (!saved || !life) return "the suspect left the room";
    const inRoster = "botStartTick" in life;
    const startTick = inRoster ? (life as RosterEntry).botStartTick : saved.tick;
    let chunks: Uint8Array[] | null = null;
    if (startTick < saved.tick) {
      chunks = await this.recordedChunks(meta, startTick);
      if (!chunks) return "its replay chunks are missing";
    }
    const live =
      trial.kind === "cpu"
        ? this.plan(meta, this.store.roster(), saved.tick, 0, trial.maxPendingSeq)
        : { spawns: [], faults: new Map<string, Fault>(), ticks: 0 };
    const liveTicks =
      trial.kind === "cpu"
        ? Math.max(1, trial.untilTick - saved.tick + 1 + TRIAL_MARGIN_TICKS)
        : SLOW_TRIAL_TICKS;
    try {
      return new TrialRunner({
        suspect: life,
        sandbox: await createSandbox({ wasmModule }),
        startTick,
        chunks,
        saved,
        spawns: live.spawns,
        faults: live.faults,
        liveTicks,
      });
    } catch (e) {
      return `its replay can't be played back (${String(e)})`;
    }
  }

  /** Recorded chunks from the one holding `fromTick` through the open one. Null if any is gone. */
  private async recordedChunks(meta: Meta, fromTick: number): Promise<Uint8Array[] | null> {
    const open = meta.openChunkTick;
    const pending = this.store.getBlob("chunk");
    if (open === null || !pending) return null;
    const size = meta.limits.chunkTicks;
    const chunks: Uint8Array[] = [];
    for (let t = Math.floor(fromTick / size) * size; t < open; t += size) {
      let bytes = this.store.outboxChunk(t);
      if (!bytes) {
        const obj = await this.env.REPLAYS.get(chunkKey(meta.roomId, t));
        if (!obj) return null;
        bytes = new Uint8Array(await obj.arrayBuffer());
      }
      chunks.push(bytes);
    }
    chunks.push(pending);
    return chunks;
  }

  /** Records the trial's verdict (a strike for `slow`/`cpu`) and resumes the room. */
  private endTrial(
    meta: Meta,
    trial: Trial,
    verdict: "cleared" | "inconclusive" | "slow" | "cpu",
    detail: string,
    atTick?: number,
  ): void {
    const life = this.findLife(trial.lifeId);
    const tick = atTick ?? this.store.getJson<World>("world")?.tick ?? 0;
    this.store.transaction(() => {
      this.store.clearMarker();
      let outcome: IncidentOutcome = verdict === "cpu" ? "culprit" : verdict;
      if ((verdict === "slow" || verdict === "cpu") && life?.versionId) {
        outcome = this.strike(meta, life, verdict, tick, detail);
      } else if ((verdict === "slow" || verdict === "cpu") && life) {
        this.store.markLeaving(life.lifeId);
      }
      this.store.addIncident({ tick, outcome, versionId: life?.versionId ?? null, at: Date.now() });
      this.store.updateMeta((m) => {
        m.trial = null;
      });
    });
    console.warn("room trial verdict", meta.roomId, trial.lifeId, verdict, detail);
  }

  /** A trial died before finishing: count it, and confirm when it reproduces. */
  private trialDied(meta: Meta, marker: BatchMarker): void {
    this.trialRun?.runner.dispose();
    this.trialRun = null;
    const trial = meta.trial;
    if (!trial) {
      this.store.clearMarker();
      return;
    }
    const verdict = judgeTrialCrash(trial, marker, Date.now(), meta.limits.cpuLimitMs);
    console.error("room trial died", meta.roomId, trial, verdict);
    if (verdict === "confirmed") {
      const detail =
        `${trial.reason}; run alone, it used up the CPU limit (${meta.limits.cpuLimitMs} ms) ` +
        `at tick ${marker.trialTick}, ${TRIAL_DEATHS_TO_CONFIRM} times`;
      this.endTrial(meta, trial, "cpu", detail, marker.trialTick ?? undefined);
    } else if (verdict === "inconclusive") {
      this.endTrial(meta, trial, "inconclusive", `${trial.attempts} trials without a verdict`);
    } else {
      this.store.transaction(() => {
        this.store.clearMarker();
        this.store.updateMeta((m) => {
          m.trial = trial;
        });
      });
    }
  }

  /**
   * Records a strike against `life`'s version (its snake dies at the next batch); bans the
   * version at `STRIKES_TO_BAN`. Returns the incident outcome. Runs inside a transaction.
   */
  private strike(
    meta: Meta,
    life: LifeEntry,
    kind: "cpu" | "slow",
    tick: number,
    detail: string,
  ): IncidentOutcome {
    const versionId = life.versionId as string;
    const now = Date.now();
    const strikes = this.store.addStrike({
      versionId,
      lifeId: life.lifeId,
      kind,
      tick,
      detail,
      at: now,
    });
    if (strikes < STRIKES_TO_BAN) return kind === "cpu" ? "culprit" : "slow";
    const ban: BanRecord = {
      versionId,
      author: life.author,
      lifeId: life.lifeId,
      roomId: meta.roomId,
      tick,
      reason: kind,
      message:
        kind === "cpu"
          ? `Banned by the arena: run alone, this bot used up the room's CPU limit (${strikes} ` +
            `lives; last: ${detail}).`
          : `Banned by the arena: run alone, this bot's ticks ran far over the time budget ` +
            `(${strikes} lives; last: ${detail}).`,
      at: now,
    };
    this.store.addBan({ versionId, lifeId: life.lifeId, tick, at: now });
    this.store.enqueue({ kind: "ban", json: JSON.stringify(ban) });
    return "banned";
  }

  /** What the next batch does. Depends only on saved state, so a rerun plans the same batch. */
  private plan(
    meta: Meta,
    roster: readonly RosterEntry[],
    tick: number,
    idleLives: number,
    maxPendingSeq: number,
  ): BatchPlan {
    const faults = new Map<string, Fault>();
    for (const e of roster) {
      if (e.versionId && this.store.isBanned(e.versionId)) faults.set(e.lifeId, "timeout");
      else if (this.store.isStruck(e.lifeId)) faults.set(e.lifeId, "timeout");
      else if (e.leaving) faults.set(e.lifeId, "error");
    }
    const staying: LifeEntry[] = roster.filter((e) => !faults.has(e.lifeId));
    const spawns: LifeEntry[] = [];
    for (const p of this.store.pending(maxPendingSeq)) {
      const taken = [...staying, ...spawns].some((e) => e.author === p.author);
      const banned =
        (p.versionId !== null && this.store.isBanned(p.versionId)) || this.store.isStruck(p.lifeId);
      if (taken || banned || staying.length + spawns.length >= meta.maxSnakes) {
        console.warn("room drops ticket", p.lifeId, { taken, banned });
        continue;
      }
      spawns.push(stripSeq(p));
    }
    spawns.push(...houseFill([...staying, ...spawns], meta.maxSnakes, meta.minAuthors, tick));
    const bots = staying.length + spawns.length;
    const starts = spawns.length + idleLives;
    let ticks = meta.limits.batchTicks || batchTicks(bots, starts, meta.limits.cpuLimitMs);
    if (meta.mode === "realtime") ticks = Math.min(ticks, REALTIME_BATCH_TICKS);
    return { spawns, faults, ticks };
  }

  /** Saves the marker (and a safety alarm) durably before a batch runs. */
  private async begin(meta: Meta, marker: BatchMarker): Promise<void> {
    this.store.setMarker(marker);
    if (!meta.manual) await this.ctx.storage.setAlarm(Date.now() + SAFETY_ALARM_MS);
    await this.ctx.storage.sync();
  }

  private commit(
    sim: RoomSim,
    result: BatchResult,
    maxPendingSeq: number,
    alsoInTransaction?: () => void,
  ): void {
    const now = Date.now();
    this.store.transaction(() => {
      const meta = this.store.meta() as Meta;
      const pending = sim.recorder.pending;
      this.store.putJson("world", sim.world);
      this.store.putBlob("chunk", pending ? encodeReplayChunk(pending) : null);
      for (const s of result.spawned) this.store.addToRoster(s);
      this.store.removePending(maxPendingSeq);
      // Chunks first: a life is delivered only after the chunk it points to.
      for (const c of result.chunks) this.store.enqueue({ kind: "chunk", ...c });
      let real = 0;
      for (const { entry, death, killer, chunkTick } of result.ended) {
        this.store.removeFromRoster(entry.lifeId);
        this.slowTicks.delete(entry.lifeId);
        if (!entry.versionId) continue;
        real++;
        const life: LifeResult = {
          lifeId: entry.lifeId,
          versionId: entry.versionId,
          author: entry.author,
          roomId: meta.roomId,
          startTick: entry.startTick,
          endTick: death.tick,
          score: death.score,
          lengthMax: death.maxMass,
          kills: death.kills,
          deathCause: entry.leaving ? "retired" : death.cause,
          killer: killer ? (killer.versionId ?? `house:${killer.house}`) : null,
          replayKey: `${meta.roomId}/${String(chunkTick).padStart(10, "0")}.zsr`,
          startedAt: entry.startedAt,
          endedAt: now,
        };
        this.store.enqueue({ kind: "life", json: JSON.stringify(life), chunkTick });
      }
      meta.livesEnded += result.ended.length;
      meta.lastBatchTicks = result.ticks;
      meta.openChunkTick = sim.openChunkTick;
      if (real > 0) meta.nextLifeAfter = 0;
      this.store.setMeta(meta);
      this.store.clearMarker();
      alsoInTransaction?.();
    });
  }

  // --- Side effects ------------------------------------------------------------------------

  /**
   * Delivers what committed batches queued: replay chunks to R2, lives (once their chunk is in
   * R2) and bans to D1 and the matchmaker. Failures retry with exponential backoff; nothing is
   * dropped.
   */
  private async drain(): Promise<void> {
    for (let pass = 0; pass < 2; pass++) {
      const meta = this.store.meta();
      if (!meta) return;
      const due = this.store.dueOutbox(Date.now(), meta.openChunkTick);
      if (due.length === 0) return;
      for (const { seq, item } of due) {
        try {
          switch (item.kind) {
            case "chunk":
              await this.env.REPLAYS.put(item.key, item.bytes);
              break;
            case "life": {
              const life = JSON.parse(item.json) as LifeResult;
              await insertLives(this.env.DB, [life]);
              await this.matchmaker().lifeEnded(life);
              break;
            }
            case "ban": {
              const ban = JSON.parse(item.json) as BanRecord;
              if ((await recordBan(this.env.DB, ban)) === "missing") {
                // Terminal: the version was deleted. The room's own ban stands; say so loudly.
                console.error("room ban: version row missing in D1", meta.roomId, ban);
              }
              await this.matchmaker().versionBanned(ban);
              break;
            }
            case "closed":
              await this.matchmaker().roomClosed(meta.roomId);
              break;
          }
          this.store.done(seq);
        } catch (e) {
          const attempts = this.store.failed(seq, (a) => Date.now() + retryDelayMs(a), String(e));
          console.error("room outbox", meta.roomId, item.kind, `attempt ${attempts}`, e);
        }
      }
    }
  }

  /**
   * Asks the matchmaker for lives while there is room. Returns true when it had none (its queue
   * is empty for us, now or at the last ask).
   */
  private async refill(): Promise<boolean> {
    const meta = this.store.meta();
    if (meta?.state !== "running") return false;
    if (Date.now() < meta.nextLifeAfter) return true;
    const present: LifeEntry[] = [...this.store.roster(), ...this.store.pending()];
    const excludeAuthors = present.map((p) => p.author);
    let vacancies = meta.maxSnakes - present.length;
    for (let asks = 0; vacancies > 0 && asks < meta.maxSnakes; asks++) {
      let ticket: LifeTicket | null;
      try {
        ticket = await this.matchmaker().nextLife({ roomId: meta.roomId, excludeAuthors });
      } catch (e) {
        console.error("room nextLife", e);
        return false;
      }
      if (!ticket) {
        this.store.updateMeta((m) => {
          m.nextLifeAfter = Date.now() + NEXT_LIFE_RETRY_MS;
        });
        return true;
      }
      const result = await this.join(ticket);
      if (!result.ok) console.warn("room refused ticket", ticket.lifeId, result.reason);
      else vacancies--;
      excludeAuthors.push(ticket.author);
    }
    return false;
  }

  private hasRealLives(): boolean {
    return (
      this.store.roster().some((e) => e.versionId !== null) ||
      this.store.pending().some((p) => p.versionId !== null)
    );
  }

  /** Only house bots left and nothing queued: save the last replay chunk and stop. */
  private async close(): Promise<void> {
    const meta = this.store.meta();
    if (!meta) return;
    const sim = await this.loadSim(meta);
    const chunks = sim.flush();
    this.store.transaction(() => {
      this.store.putJson("world", sim.world);
      this.store.putBlob("chunk", null);
      for (const c of chunks) this.store.enqueue({ kind: "chunk", ...c });
      this.store.enqueue({ kind: "closed" });
      meta.state = "closed";
      meta.openChunkTick = null;
      this.store.setMeta(meta);
    });
    this.dropSim();
    await this.drain();
    // Anything still undelivered retries from alarms.
    const outbox = this.store.outboxStats();
    if (outbox.size > 0) await this.scheduleRetry(meta, outbox.nextAt);
    else await this.ctx.storage.deleteAlarm();
  }

  // --- Scheduling --------------------------------------------------------------------------

  /** Makes sure a batch runs soon (a ticket arrived). */
  private async kick(meta: Meta): Promise<void> {
    if (meta.manual || meta.state !== "running") return;
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
  }

  private async scheduleNext(): Promise<void> {
    const meta = this.store.meta();
    if (meta?.state !== "running" || meta.manual) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const now = Date.now();
    if (meta.mode === "accelerated") {
      await this.ctx.storage.setAlarm(now);
      return;
    }
    // Real time: one batch of ticks per its duration; if we fell behind, carry on from now.
    // (A batch planned before a switch to real time may have been longer: don't wait for it.)
    const ticks = Math.min(meta.lastBatchTicks, REALTIME_BATCH_TICKS);
    let next = Math.max(meta.realtimeNext, now - 1000) + ticks * TICK_MS;
    if (next < now) next = now;
    meta.realtimeNext = next;
    this.store.setMeta(meta);
    await this.ctx.storage.setAlarm(next);
  }

  /** Paused, or closed with deliveries left: wake up when the next retry is due. */
  private async scheduleRetry(meta: Meta, nextAt: number | null): Promise<void> {
    if (meta.manual) return;
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, nextAt ?? 0));
  }

  // --- Helpers -----------------------------------------------------------------------------

  private async loadSim(meta: Meta): Promise<RoomSim> {
    if (this.sim) return this.sim;
    const world = this.store.getJson<World>("world");
    if (!world) throw new Error("room has no world");
    const chunk = this.store.getBlob("chunk");
    const sandbox = await createSandbox({ wasmModule });
    this.sim = new RoomSim(
      meta.roomId,
      world,
      chunk ? decodeReplayChunk(chunk) : null,
      sandbox,
      this.store.roster(),
      meta.limits.chunkTicks,
    );
    return this.sim;
  }

  private dropSim(): void {
    this.sim?.dispose();
    this.sim = null;
  }

  private findLife(lifeId: string): LifeEntry | null {
    return (
      this.store.roster().find((e) => e.lifeId === lifeId) ??
      this.store.pending().find((p) => p.lifeId === lifeId) ??
      null
    );
  }

  private matchmaker(): MatchmakerRpc {
    return this.env.MATCHMAKER.get(this.env.MATCHMAKER.idFromName("global"));
  }
}

function stripSeq({ seq: _, ...entry }: PendingEntry): LifeEntry {
  return entry;
}
