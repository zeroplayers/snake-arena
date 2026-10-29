import { DurableObject } from "cloudflare:workers";
import {
  CHUNK_TICKS,
  createWorld,
  DEFAULT_CONFIG,
  decodeReplayChunk,
  encodeReplayChunk,
  type Fault,
  REPLAY_VERSION,
  replayChunkVersion,
  sameRules,
  TICK_RATE,
  type World,
} from "@zerosnake/engine";
import { log, type MetricFields, writeMetric } from "@zerosnake/observability";
import { createSandbox, type InstrumentResult, instrument } from "@zerosnake/sandbox";
import { ARENA_CONTROL_POLL_MS, traceKey } from "@zerosnake/web/shared";
// Wrangler only treats specifiers ending in .wasm as compiled modules; the package's "./wasm"
// export doesn't, so the file is imported by path.
import wasmModule from "../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm";
import {
  arenaPaused,
  insertLives,
  isQuarantined,
  recordKill,
  recordQuarantine,
  retractKills,
} from "./db.ts";
import {
  batchTicks,
  DEFAULT_MAX_OUTBOX,
  DEFAULT_MAX_SNAKES,
  DO_CPU_LIMIT_MS,
  METRICS_MS,
  NEXT_LIFE_RETRY_MS,
  OUTBOX_PER_CYCLE,
  REALTIME_BATCH_TICKS,
  ROOM_CPU_BUDGET_MS,
  SAFETY_ALARM_MS,
} from "./limits.ts";
import type {
  IncidentOutcome,
  JoinResult,
  LifeDrop,
  LifeResult,
  LifeTicket,
  MatchmakerRpc,
  QuarantineRecord,
  RoomMode,
  RoomRpc,
  RoomStartOptions,
  RoomStatus,
  VersionKillRecord,
} from "./protocol.ts";
import {
  ageKills,
  type BotCall,
  blameCall,
  DEFAULT_WATCH_GAP_MS,
  EVICTIONS_TO_QUARANTINE,
  INCIDENT_WINDOW_MS,
  judgeCrash,
  KILL_WINDOW_TICKS,
  type NamedKill,
  nextKills,
  nextVersionKills,
  ROOM_KILLS_TO_EVICT,
  retryDelayMs,
  type TimedCall,
  VERSION_KILL_WINDOW_MS,
  VERSION_KILLS_TO_QUARANTINE,
  type Verdict,
  type VersionKill,
  WATCH_ABORT_SHARE,
  WATCH_GAP_CAP_SHARE,
  WATCH_STOP_SHARE,
  WATCH_WALL_SHARE,
  watchGapMs,
  watching,
  watchWindow,
} from "./room/backstop.ts";
import { BundleCache, lifeStarter } from "./room/bundles.ts";
import { houseFill, houseToRetire } from "./room/house.ts";
import { BatchMetrics } from "./room/metrics.ts";
import {
  type BatchHooks,
  type BatchPlan,
  type BatchResult,
  chunkKey,
  type LifeStarter,
  RoomSim,
} from "./room/sim.ts";
import {
  ACK_TIMEOUT_MS,
  labelsFromD1,
  SPECTATOR_GRACE_MS,
  type SpectatedRoom,
  Spectators,
} from "./room/spectators.ts";
import {
  type BatchMarker,
  type LifeEntry,
  type Meta,
  type PendingEntry,
  RoomStore,
  type RosterEntry,
} from "./room/store.ts";
import { gzip } from "./room/trace.ts";
import { TraceStore } from "./room/trace-store.ts";
import { SHOWCASE_REPORT_MS, showcase } from "./showcase.ts";

const TICK_MS = 1000 / TICK_RATE;
/**
 * With no real lives left and nothing from the matchmaker, a room whose finished lives' reports
 * haven't reached it yet (they wait for their replay chunk) waits for them up to a chunk of real
 * time plus this before closing: those bots may come back here, so a lone bot doesn't get a new
 * room per life.
 */
const REPORT_GRACE_MS = 60_000;

/**
 * One persistent room of 20 snakes (SPEC §4–5): deployed bots' lives, at most one per author, and
 * house bots in every slot they don't use (house snakes make way for them). Simulated in batches
 * of ticks from `alarm()`: as fast as the CPU allows (`accelerated`) or at 10 ticks/s
 * (`realtime`).
 *
 * A batch, step by step:
 *  1. plan: spawn the pending tickets, retiring house snakes for those that don't fit (user lives
 *     take priority), fill every free slot with house bots, kill evicted and leaving lives; size
 *     the batch for the worst case (see `limits.ts`);
 *  2. write a marker with the invocation's start time and `sync()` it, so a batch that dies is
 *     noticed by the next alarm;
 *  3. run it (engine + one QuickJS life per snake, recorded by `ReplayRecorder`);
 *  4. in one transaction: save the world, the open replay chunk, the roster and what changed in
 *     the lives' traces (`room/trace.ts`, `room/trace-store.ts`), queue the side effects (replay
 *     chunks and finished lives' traces for R2, finished lives for D1 and the matchmaker), clear
 *     the marker;
 *  5. deliver the outbox, ask the matchmaker for replacements, schedule the next alarm (or close
 *     when only house bots are left and no reports that could bring bots back are pending).
 *
 * Backstop (`room/backstop.ts`): a marker left over means the batch died. If too little wall time
 * passed for it to have been the CPU limit, it was a restart: the batch runs again and counts for
 * nothing. Otherwise the room switches to watch mode (each bot call made durable, a random wait
 * after it, batches stopped early) for a window that grows with repeated incidents. Nobody is ever
 * struck or banned for a kill: a life that watched kills keep naming is evicted (neutral end, not
 * rated) so the room makes progress (the kill window, `backstop.ts`), and a version evicted
 * `EVICTIONS_TO_QUARANTINE` times, or named by `VERSION_KILLS_TO_QUARANTINE` kills (the version
 * tally, here and across rooms in D1), is quarantined for every room (`versions.quarantined_at`).
 * A watched call that returns after running past the abort share by itself is named like a kill.
 *
 * Spectators (`room/spectators.ts`, #27) connect over WebSockets (`fetch`, routed by the
 * showcase, `showcase.ts`) and get every saved batch's ticks; while they watch, the room runs in
 * real time whatever its mode. Running rooms report themselves to the showcase registry.
 *
 * The arena's kill switch (`arena_control.paused` in D1, re-read every `ARENA_CONTROL_POLL_MS`):
 * while it's on, the room starts no lives, retires the running ones and closes.
 *
 * A room keeps the rules (`EngineConfig`) it started with: its saved world and replay carry them.
 * One started before the defaults changed (e.g. `turnRate` in #98) is superseded: it takes no new
 * lives, lets the running ones play out on the old rules, then closes; new rooms get the new ones.
 *
 * After any reload (eviction or crash) every bot restarts with `init` and empty memory; the
 * world, replay and roster continue exactly.
 *
 * Metrics (`@zerosnake/observability`, the `METRICS` Analytics Engine binding; none without it):
 * `room.started`, `room.batch` (sums of batches, at most every `metricsMs`), `room.crashed` (each
 * backstop incident, and alarms that throw), `room.evicted`, `version.quarantined`, `life.ended`
 * (once delivered) and `room.closed`. Incidents are also logged as structured records.
 */
export class RoomDO extends DurableObject<Env> implements RoomRpc {
  private readonly store: RoomStore;
  private readonly traces: TraceStore;
  private sim: RoomSim | null = null;
  /** Instrumented bundles of the room's lives; outlive `sim`, so a rerun reuses them. */
  private readonly bundles = new BundleCache((source) => this.instrumentBundle(source));
  private busy = false;
  /** The kill switch as last read from D1, and when (wall ms; in memory only). */
  private paused = false;
  private pausedReadAt = 0;
  private readonly spectators: Spectators;
  /** When the room last reported itself to the showcase (wall ms; in memory only). */
  private reportedAt = 0;
  /** Sums of the batches since the last `room.batch` metric (in memory only). */
  private readonly metrics = new BatchMetrics(Date.now());
  /** Outbox items the cycle in progress may still deliver (`drain`). */
  private drainLeft = 0;
  /** Whether the world's rules are today's defaults (`superseded`); null until known. */
  private rulesCurrent: boolean | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new RoomStore(ctx.storage);
    this.traces = new TraceStore(ctx.storage.sql);
    this.spectators = new Spectators(ctx, () => this.spectated(), labelsFromD1(env.DB));
  }

  // --- Spectators ----------------------------------------------------------------------------

  /** A spectator's WebSocket upgrade (from the showcase route). */
  override async fetch(request: Request): Promise<Response> {
    return this.spectators.accept(request);
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.spectators.message(ws, message);
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.spectators.closed(ws, code, reason);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.spectators.closed(ws, 1011, "error");
  }

  /** What spectators see of the room; null unless it is running. */
  private spectated(): SpectatedRoom | null {
    const meta = this.store.meta();
    if (meta?.state !== "running") return null;
    return {
      roomId: meta.roomId,
      idleWorld: () => (this.busy ? null : (this.sim?.world ?? this.store.getJson<World>("world"))),
      life: (lifeId) =>
        this.findLife(lifeId) ?? this.sim?.roster.find((e) => e.lifeId === lifeId) ?? null,
      versionIds: () =>
        [...this.store.roster(), ...this.store.pending()].flatMap((e) =>
          e.versionId === null ? [] : [e.versionId],
        ),
    };
  }

  /** The mode the room runs in: real time while spectators watch (and a grace period after). */
  private mode(meta: Meta): RoomMode {
    const graceMs = meta.limits.spectatorGraceMs ?? SPECTATOR_GRACE_MS;
    return this.spectators.wantsRealtime(Date.now(), graceMs) ? "realtime" : meta.mode;
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
        ...(options.fillTo !== undefined && { fillTo: options.fillTo }),
        manual: options.manual ?? false,
        limits: {
          cpuLimitMs: limits.cpuLimitMs ?? DO_CPU_LIMIT_MS,
          cpuBudgetMs:
            limits.cpuBudgetMs ??
            Math.min(ROOM_CPU_BUDGET_MS, limits.cpuLimitMs ?? DO_CPU_LIMIT_MS),
          batchTicks: limits.batchTicks ?? 0,
          maxOutbox: limits.maxOutbox ?? DEFAULT_MAX_OUTBOX,
          chunkTicks: limits.chunkTicks ?? CHUNK_TICKS,
          watchGapMs: limits.watchGapMs ?? DEFAULT_WATCH_GAP_MS,
          arenaControlPollMs: limits.arenaControlPollMs ?? ARENA_CONTROL_POLL_MS,
          killWindowTicks: limits.killWindowTicks ?? KILL_WINDOW_TICKS,
          spectatorGraceMs: limits.spectatorGraceMs ?? SPECTATOR_GRACE_MS,
          spectatorAckTimeoutMs: limits.spectatorAckTimeoutMs ?? ACK_TIMEOUT_MS,
          metricsMs: limits.metricsMs ?? METRICS_MS,
          outboxPerCycle: limits.outboxPerCycle ?? OUTBOX_PER_CYCLE,
        },
        livesEnded: 0,
        startedAt: Date.now(),
        lastBatchTicks: 0,
        nextLifeAfter: 0,
        realtimeNext: 0,
        watch: { untilTick: 0, untilMs: 0 },
        openChunkTick: null,
        kills: [],
        versionKills: [],
      };
      this.store.transaction(() => {
        this.store.setMeta(meta);
        this.store.putJson("world", world);
        this.store.putBlob("chunk", null);
      });
      writeMetric(this.env.METRICS, "room.started", {
        roomId: meta.roomId,
        mode: meta.mode,
        maxSnakes: meta.maxSnakes,
      });
    }
    return this.status();
  }

  async join(ticket: LifeTicket): Promise<JoinResult> {
    const meta = this.store.meta();
    if (meta?.state !== "running" || this.paused || this.superseded()) {
      return { ok: false, reason: "closed" };
    }
    if (this.store.isQuarantined(ticket.versionId) || (await this.quarantinedInD1(ticket))) {
      return { ok: false, reason: "quarantined" };
    }
    const present = [...this.store.roster(), ...this.store.pending()];
    if (present.some((p) => p.lifeId === ticket.lifeId)) {
      return { ok: false, reason: "duplicate-life" };
    }
    if (present.some((p) => p.author === ticket.author)) {
      return { ok: false, reason: "author-present" };
    }
    // House snakes don't count: they make way for it at the next batch (`plan`).
    if (present.filter((p) => p.versionId !== null).length >= meta.maxSnakes) {
      return { ok: false, reason: "full" };
    }
    this.store.addPending({ ...ticket, house: null });
    await this.kick(meta);
    return { ok: true };
  }

  async leave(lifeId: string): Promise<boolean> {
    if (this.store.markLeaving(lifeId)) {
      this.sim?.markLeaving(lifeId);
      return true;
    }
    const ticket = this.store.pending().find((p) => p.lifeId === lifeId);
    if (!ticket) return false;
    // The batch in progress (or one that died, to run again) may spawn it: dropping it now would
    // report a life that's about to run. Once in the roster, the matchmaker's retry retires it.
    if (ticket.seq <= (this.store.marker()?.maxPendingSeq ?? 0)) return false;
    if (!this.store.removePendingLife(lifeId)) return false;
    this.dropTicket(ticket, "left");
    return true;
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
      mode: meta ? this.mode(meta) : "accelerated",
      spectators: this.spectators.count,
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
      evictions: this.store
        .evictions()
        .map(({ versionId, lifeId, tick }) => ({ versionId, lifeId, tick })),
      quarantined: this.store.quarantined(),
      kills: meta?.kills ?? [],
      versionKills: (meta?.versionKills ?? []).map(({ versionId, lifeId, tick }) => ({
        versionId,
        lifeId,
        tick,
      })),
      arenaPaused: this.paused,
      watching: meta ? watching(meta.watch, world?.tick ?? 0, Date.now()) : false,
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
      this.drainLeft = meta.limits.outboxPerCycle ?? OUTBOX_PER_CYCLE;
      await this.drain();
      const outbox = this.store.outboxStats();
      if (meta.state !== "running") {
        if (outbox.size > 0) await this.scheduleRetry(meta, outbox.nextAt);
        return;
      }
      if (outbox.size > meta.limits.maxOutbox) {
        // D1/R2/matchmaker are failing: don't produce more until they recover.
        log("error", "room.outbox_full", { roomId: meta.roomId, ...outbox });
        await this.scheduleRetry(meta, outbox.nextAt);
        return;
      }
      if (this.outdated()) {
        await this.closeOutdated(meta);
        return;
      }
      if (await this.arenaStopped(meta)) this.retireAll();
      try {
        const marker = this.store.marker();
        if (marker) await this.recover(meta, marker, invokedAt);
        else await this.batch(invokedAt);
      } catch (e) {
        // The in-memory room may be half a batch ahead of storage: drop it. The marker stays,
        // so the next cycle handles this like a batch that died.
        this.dropSim();
        this.spectators.abort();
        this.reportIncident(meta.roomId, "exception", null, Date.now(), { error: e });
        this.markReported();
        throw e;
      }
      await this.drain();
      const queueEmpty = this.paused || (await this.refill());
      const idle = queueEmpty && !this.hasRealLives();
      // A superseded room's bots can't come back: no reason to wait for their reports.
      if (idle && (this.superseded() || !this.awaitingReports())) await this.close();
      else {
        if (!idle && this.store.meta()?.idleSince) {
          this.store.updateMeta((m) => {
            m.idleSince = 0;
          });
        }
        await this.scheduleNext();
        await this.reportShowcase();
      }
    } finally {
      this.busy = false;
    }
  }

  private async batch(invokedAt: number): Promise<void> {
    const meta = this.store.meta();
    if (!meta) return;
    const sim = await this.loadSim(meta);
    const maxPendingSeq = this.store.lastPendingSeq();
    const plan = this.plan(meta, sim.roster, sim.world, sim.idleLives, maxPendingSeq);
    const watch = watching(meta.watch, sim.world.tick, Date.now());
    // Labels of the lives spectators are about to see (D1 only for versions not seen yet).
    await this.spectators.prepare();
    const marker: BatchMarker = {
      fromTick: sim.world.tick,
      maxPendingSeq,
      startedAt: invokedAt,
      watch,
      call: null,
    };
    await this.begin(meta, marker);
    const watcher = watch ? this.watchHooks(meta, marker) : null;
    const afterStep = this.spectators.beginBatch(sim.world);
    // The batch's wall time (`room.batch`'s `wallMs`) runs from here, after the I/O before it.
    const ranFrom = Date.now();
    const result = await sim.run(plan, { ...watcher?.hooks, ...(afterStep && { afterStep }) });
    const blamed = watcher?.blamed() ?? null;
    const overran = this.commit(sim, result, maxPendingSeq, () => {
      if (!blamed) return null;
      // A call that ran past the abort share by itself: named as a kill would have named it.
      const now = Date.now();
      const verdict: Verdict = {
        kind: "suspect",
        call: blamed.call,
        gapMs: now - invokedAt,
        callMs: blamed.ms,
      };
      return { verdict, counted: this.countIncident(verdict, true, sim.world.tick, now), now };
    });
    if (overran) {
      const { verdict, counted, now } = overran;
      this.reportIncident(meta.roomId, "overran", verdict, now, { counted });
    }
    this.spectators.commit(sim.world, meta.limits.spectatorAckTimeoutMs ?? ACK_TIMEOUT_MS);
    // Some bots ran a tick the world never stepped (or one was evicted): restart them from the
    // saved frame.
    if (result.aborted || blamed) this.dropSim();
    // The clock stands still during CPU work: a timer moves it to the batch's end.
    await new Promise((r) => setTimeout(r, 0));
    const now = Date.now();
    this.metrics.add({
      ticks: result.ticks,
      botTicks: result.botTicks,
      workUnits: result.work,
      livesStarted: result.spawned.filter((e) => e.versionId !== null).length,
      livesEnded: result.ended.filter((e) => e.entry.versionId !== null).length,
      houseRetired: plan.houseRetired,
      wallMs: now - ranFrom,
      watched: watch,
      cut: result.aborted || blamed !== null || result.ticks < plan.ticks,
    });
    this.flushMetrics(meta, sim.world, now);
  }

  /**
   * Watch mode: before each bot call, make "this call is running" durable, and stop the batch at
   * shares of the room's CPU budget (wall time minus the random waits bounds its CPU from above).
   * While the kill window holds a kill (a watched kill named a life), also make "between calls"
   * durable after each call and wait a random while (wall time only), so most of the batch's wall
   * time is between calls and a restart rarely names a life again. Without one that isn't needed:
   * a kill only names a call that ran for most of the CPU limit, which restarts in production
   * practically never look like.
   *
   * Each call's own wall time (from after its marker's sync to the next I/O) is kept for the tick
   * in progress: a call that ran past the abort share ends the batch, and `blamed` names it (or the
   * slowest call of a tick abandoned because its calls overran; see `blameCall`).
   */
  private watchHooks(
    meta: Meta,
    marker: BatchMarker,
  ): { hooks: BatchHooks; blamed: () => TimedCall | null } {
    // The room's budget, not the hard limit: an honest watched invocation stays far below it.
    const limit = meta.limits.cpuBudgetMs;
    const decorrelate = (meta.kills ?? []).length > 0;
    let callAt = 0;
    let ranFrom = 0;
    let slept = 0;
    let first = true;
    /** The calls of the tick in progress (the first tick's include the lives' starts). */
    let calls: TimedCall[] = [];
    let blamed: TimedCall | null = null;
    const busy = () => Date.now() - marker.startedAt - slept;
    const wait = async (ms: number) => {
      await new Promise((r) => setTimeout(r, ms));
      slept += ms;
    };
    // Any I/O moves the clock (bot code and the engine step are CPU); a timer is cheapest.
    const tock = () => new Promise((r) => setTimeout(r, 0));
    const hooks: BatchHooks = {
      shuffleStarts: decorrelate,
      continueBatch: () => {
        blamed = blameCall(calls, false, limit);
        calls = [];
        return (
          blamed === null &&
          busy() < WATCH_STOP_SHARE * limit &&
          Date.now() - marker.startedAt < WATCH_WALL_SHARE * limit
        );
      },
      beforeBot: async (lifeId, kind, tick) => {
        if (decorrelate && first) await wait(Math.random() * WATCH_GAP_CAP_SHARE * limit);
        first = false;
        await tock();
        if (kind === "tick") {
          blamed = blameCall(calls, false, limit);
          if (blamed) return "abort";
          if (busy() > WATCH_ABORT_SHARE * limit) {
            blamed = blameCall(calls, true, limit);
            return "abort";
          }
        }
        callAt = Date.now();
        marker.call = { lifeId, kind, tick, at: callAt, before: busy() };
        this.store.setMarker(marker);
        await this.ctx.storage.sync();
        ranFrom = Date.now();
        return "go";
      },
      afterBot: async () => {
        await tock();
        if (marker.call) calls.push({ call: marker.call, ms: Date.now() - ranFrom });
        if (!decorrelate) return;
        marker.call = null;
        this.store.setMarker(marker);
        await this.ctx.storage.sync();
        await wait(watchGapMs(Date.now() - callAt, meta.limits.watchGapMs, Math.random(), limit));
      },
    };
    // A batch that ran all its ticks has no `continueBatch` after the last one.
    return { hooks, blamed: () => blamed ?? blameCall(calls, false, limit) };
  }

  /**
   * A batch died before saving its result (the marker is still there). Count it toward evicting
   * the life whose call it interrupted (the kill window and the version tally), watch the room, and
   * run the batch again from the saved frame (every bot restarts there).
   */
  private async recover(meta: Meta, marker: BatchMarker, invokedAt: number): Promise<void> {
    this.dropSim();
    const now = Date.now();
    const verdict = judgeCrash(marker, now, meta.limits.cpuLimitMs);
    const counted = this.store.transaction(() => {
      this.store.clearMarker();
      return this.countIncident(verdict, marker.watch, marker.fromTick, now);
    });
    // An alarm that threw wrote this incident's point already (`exception`): only log it.
    this.reportIncident(meta.roomId, counted.outcome, verdict, now, {
      counted,
      reported: marker.exception === true,
    });
    await this.batch(invokedAt);
  }

  /**
   * Counts an incident (inside a transaction): the kill window and the version tally (and D1's,
   * through the outbox), the evictions and quarantine they lead to, and the watch window. `tick` is
   * the frame the room restarts from.
   */
  private countIncident(verdict: Verdict, watched: boolean, tick: number, now: number): Counted {
    const meta = this.store.meta() as Meta;
    const named = verdict.kind === "suspect" ? this.findLife(verdict.call.lifeId) : null;
    const window = meta.limits.killWindowTicks ?? KILL_WINDOW_TICKS;
    const { kills, evict } = nextKills(meta.kills ?? [], verdict, watched, tick, window);
    const kill: VersionKill | null =
      verdict.kind === "suspect" && named?.versionId
        ? {
            id: crypto.randomUUID(),
            versionId: named.versionId,
            author: named.author,
            lifeId: named.lifeId,
            tick: verdict.call.tick,
            at: now,
          }
        : null;
    const tally = nextVersionKills(meta.versionKills ?? [], verdict, watched, kill, now);
    const versionKills = kill
      ? tally.kills.filter((k) => k.versionId === kill.versionId).length
      : 0;
    let outcome: IncidentOutcome = verdict.kind;
    if (verdict.kind === "suspect") {
      const call = verdict.call;
      // A life's own count keeps the window; the room's cap empties it.
      const capped = kills.length === 0;
      const evicting = new Set(evict);
      if (tally.quarantine && named) evicting.add(named.lifeId);
      for (const lifeId of evicting) {
        const life = lifeId === named?.lifeId ? named : this.findLife(lifeId);
        if (!life) continue;
        const detail =
          capped && evict.includes(lifeId)
            ? `one of the bots whose calls ${ROOM_KILLS_TO_EVICT} kills in a row interrupted, ` +
              `last at room tick ${call.tick} (${meta.limits.cpuLimitMs} ms CPU limit)`
            : evictionDetail(meta, call);
        this.evict(meta, life, call.tick, detail, now, lifeId === named?.lifeId ? versionKills : 0);
        if (lifeId === named?.lifeId) outcome = "evicted";
      }
    }
    // After the room's own quarantine (if any), so the matchmaker hears of that first.
    if (kill) this.store.enqueue({ kind: "kill", json: JSON.stringify(killRecord(meta, kill)) });
    if (tally.retract.length > 0) {
      const records = tally.retract.map((k) => killRecord(meta, k));
      this.store.enqueue({ kind: "retract", json: JSON.stringify(records) });
    }
    this.store.addIncident({ tick, outcome, versionId: named?.versionId ?? null, at: now });
    if (verdict.kind !== "restart") {
      const recent = this.store.cpuIncidentsSince(now - INCIDENT_WINDOW_MS);
      this.store.updateMeta((m) => {
        m.kills = kills;
        m.versionKills = tally.kills;
        m.watch = watchWindow(m.watch, recent, tick, now, DEFAULT_CONFIG.lifeCap);
      });
    }
    return {
      kills,
      evict: [...evict],
      versionKills,
      outcome,
      versionId: named?.versionId ?? null,
    };
  }

  /**
   * An incident (`countIncident`'s, a watched call that `overran`, or an alarm that threw):
   * the `room.crashed` metric and a structured log. `reported`: the alarm that threw wrote the
   * metric for this incident already, so only the log is written.
   */
  private reportIncident(
    roomId: string,
    cause: IncidentOutcome | "overran" | "exception",
    verdict: Verdict | null,
    now: number,
    {
      error,
      counted,
      reported = false,
    }: { error?: unknown; counted?: Counted; reported?: boolean } = {},
  ): void {
    let restarts = 0;
    try {
      restarts = this.store.incidentsSince(now - INCIDENT_WINDOW_MS);
    } catch {
      // Storage may be what threw: report the incident anyway.
    }
    const fields = {
      roomId,
      cause,
      versionId: counted?.versionId ?? null,
      restarts,
      gapMs: verdict?.gapMs ?? 0,
      callMs: verdict?.kind === "suspect" ? verdict.callMs : 0,
    };
    if (!reported) writeMetric(this.env.METRICS, "room.crashed", fields);
    log(cause === "restart" ? "warn" : "error", "room.crashed", {
      ...fields,
      ...(reported && { reportedAs: "exception" }),
      ...(verdict?.kind === "suspect" && { call: verdict.call }),
      ...(counted && { kills: counted.kills.length, evict: counted.evict }),
      error,
    });
  }

  /**
   * Ends `life` with the neutral cause `evicted` (at the next batch, without running its code
   * again; a pending ticket is dropped), and quarantines its version after
   * `EVICTIONS_TO_QUARANTINE` evictions in this room, or when `versionKills` (its version's named
   * kills in the tally) reached `VERSION_KILLS_TO_QUARANTINE`. Runs inside a transaction.
   */
  private evict(
    meta: Meta,
    life: LifeEntry,
    tick: number,
    detail: string,
    now: number,
    versionKills: number,
  ): void {
    if (!this.store.markEvicted(life.lifeId)) {
      // Killed while starting its life: it never made it into the roster.
      this.store.removePendingLife(life.lifeId);
      if (life.versionId) {
        const chunkTick =
          meta.openChunkTick ?? Math.floor(tick / meta.limits.chunkTicks) * meta.limits.chunkTicks;
        const result: LifeResult = {
          lifeId: life.lifeId,
          versionId: life.versionId,
          author: life.author,
          roomId: meta.roomId,
          startTick: tick,
          endTick: tick,
          score: 0,
          lengthMax: 0,
          kills: 0,
          deathCause: "evicted",
          killer: null,
          replayKey: chunkKey(meta.roomId, chunkTick),
          startedAt: now,
          endedAt: now,
        };
        this.store.enqueue({
          kind: "life",
          json: JSON.stringify(result),
          chunkTick,
          traceKey: null,
        });
      }
    }
    const versionId = life.versionId;
    const evictions = this.store.addEviction({
      versionId,
      lifeId: life.lifeId,
      tick,
      detail,
      at: now,
    });
    log("warn", "room.evicted", {
      roomId: meta.roomId,
      lifeId: life.lifeId,
      versionId,
      evictions,
      versionKills,
      detail,
    });
    writeMetric(this.env.METRICS, "room.evicted", {
      roomId: meta.roomId,
      versionId,
      evictions,
      versionKills,
    });
    const quarantine =
      evictions >= EVICTIONS_TO_QUARANTINE || versionKills >= VERSION_KILLS_TO_QUARANTINE;
    if (!versionId || !quarantine || this.store.isQuarantined(versionId)) return;
    this.store.quarantine(versionId, now);
    this.reportQuarantine("room", meta.roomId, versionId, evictions, versionKills);
    const record: QuarantineRecord = {
      versionId,
      author: life.author,
      lifeId: life.lifeId,
      roomId: meta.roomId,
      tick,
      evictions,
      kills: versionKills,
      message:
        "Quarantined by the arena for review: the room's CPU backstop kept naming this bot's " +
        `code (${versionKills || "several"} calls killed by the CPU limit or running past the ` +
        `room's budget), so ${evictions} of its lives ${evictions === 1 ? "was" : "were"} ` +
        `evicted (last: ${detail}). ${CAUSE}`,
      at: now,
    };
    this.store.enqueue({ kind: "quarantine", json: JSON.stringify(record) });
  }

  /**
   * What the next batch does. Depends only on saved state (the roster, the pending tickets and
   * the saved `world`), so a rerun plans the same batch.
   *
   * Only deployed bots' lives count toward `maxSnakes` for tickets: a house snake's slot is free
   * for them. Tickets take the slots left by dead snakes first; past `maxSnakes`, house snakes
   * give theirs up (`houseToRetire`) and die on the batch's first tick without running their code
   * again, like a leaving life. House bots then fill what is still free, up to `fillTo`.
   */
  private plan(
    meta: Meta,
    roster: readonly RosterEntry[],
    world: World,
    idleLives: number,
    maxPendingSeq: number,
  ): BatchPlan & { houseRetired: number } {
    const faults = new Map<string, Fault>();
    // The engine has no `evicted` cause: the replay shows `error`, the life result `evicted`.
    for (const e of roster) if (e.evicted || e.leaving) faults.set(e.lifeId, "error");
    let staying: RosterEntry[] = roster.filter((e) => !faults.has(e.lifeId));
    const spawns: LifeEntry[] = [];
    let real = staying.filter((e) => e.versionId !== null).length;
    for (const p of this.store.pending(maxPendingSeq)) {
      const taken = [...staying, ...spawns].some((e) => e.author === p.author);
      const quarantined = p.versionId !== null && this.store.isQuarantined(p.versionId);
      if (taken || quarantined || real >= meta.maxSnakes) {
        console.warn("room drops ticket", p.lifeId, { taken, quarantined });
        continue;
      }
      spawns.push(stripSeq(p));
      if (p.versionId !== null) real++;
    }
    // User lives take priority: house snakes make way for the tickets that don't fit.
    const mass = new Map(world.snakes.map((s) => [s.id, s.mass]));
    const retire = houseToRetire(
      staying
        .filter((e) => e.versionId === null)
        .map((e) => ({ lifeId: e.lifeId, mass: mass.get(e.lifeId) ?? 0, startTick: e.startTick })),
      staying.length + spawns.length - meta.maxSnakes,
    );
    for (const lifeId of retire) faults.set(lifeId, "error");
    if (retire.length > 0) staying = staying.filter((e) => !faults.has(e.lifeId));
    // House bots keep real lives company in every free slot; with none (the arena stopped), the
    // room closes.
    if (real > 0) {
      const fillTo = Math.min(meta.fillTo ?? meta.maxSnakes, meta.maxSnakes);
      spawns.push(...houseFill([...staying, ...spawns], fillTo, world.tick));
    }
    const bots = staying.length + spawns.length;
    const starts = spawns.length + idleLives;
    let ticks = meta.limits.batchTicks || batchTicks(bots, starts, meta.limits.cpuBudgetMs);
    if (this.mode(meta) === "realtime") ticks = Math.min(ticks, REALTIME_BATCH_TICKS);
    return { spawns, faults, ticks, houseRetired: retire.length };
  }

  /** Saves the marker (and a safety alarm) durably before a batch runs. */
  private async begin(meta: Meta, marker: BatchMarker): Promise<void> {
    this.store.setMarker(marker);
    if (!meta.manual) await this.ctx.storage.setAlarm(Date.now() + SAFETY_ALARM_MS);
    await this.ctx.storage.sync();
  }

  /** Saves a batch's result; `then` runs last, in the same transaction, and gives the result. */
  private commit<T>(sim: RoomSim, result: BatchResult, maxPendingSeq: number, then: () => T): T {
    const now = Date.now();
    return this.store.transaction(() => {
      const meta = this.store.meta() as Meta;
      const pending = sim.recorder.pending;
      this.store.putJson("world", sim.world);
      this.store.putBlob("chunk", pending ? encodeReplayChunk(pending) : null);
      for (const t of sim.traceChanges()) this.traces.save(t.lifeId, t.changes);
      for (const s of result.spawned) this.store.addToRoster(s);
      const spawned = new Set(result.spawned.map((s) => s.lifeId));
      for (const p of this.store.pending(maxPendingSeq)) {
        if (!spawned.has(p.lifeId)) this.dropTicket(p, "spawn");
      }
      this.store.removePending(maxPendingSeq);
      // Chunks first: a life is delivered only after the chunk it points to.
      for (const c of result.chunks) this.store.enqueue({ kind: "chunk", ...c });
      let real = 0;
      for (const { entry, death, killer, chunkTick, trace } of result.ended) {
        this.store.removeFromRoster(entry.lifeId);
        if (trace) this.traces.delete(entry.lifeId);
        if (!entry.versionId) continue;
        real++;
        const deathCause = entry.evicted ? "evicted" : entry.leaving ? "retired" : death.cause;
        const killerKey = killer ? (killer.versionId ?? `house:${killer.house}`) : null;
        // Evicted lives get no row (`db.ts`), so nothing would point at their trace.
        let key: string | null = null;
        if (trace && deathCause !== "evicted") {
          key = traceKey(entry.lifeId, now);
          const bytes = trace.finish({ endTick: death.tick, cause: deathCause, killer: killerKey });
          // Before the life: it is delivered only after its trace.
          this.store.enqueue({ kind: "trace", key, bytes });
        }
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
          deathCause,
          killer: killerKey,
          replayKey: chunkKey(meta.roomId, chunkTick),
          traceKey: key,
          startedAt: entry.startedAt,
          endedAt: now,
        };
        this.store.enqueue({ kind: "life", json: JSON.stringify(life), chunkTick, traceKey: key });
      }
      meta.livesEnded += result.ended.length;
      meta.lastBatchTicks = result.ticks;
      meta.openChunkTick = sim.openChunkTick;
      if (real > 0) meta.nextLifeAfter = 0;
      // Progress ages kills out of the window.
      meta.kills = ageKills(
        meta.kills ?? [],
        sim.world.tick,
        meta.limits.killWindowTicks ?? KILL_WINDOW_TICKS,
      );
      this.store.setMeta(meta);
      this.store.clearMarker();
      return then();
    });
  }

  // --- Side effects ------------------------------------------------------------------------

  /**
   * Delivers what committed batches queued: replay chunks and life traces to R2, lives (once their
   * chunk and trace are in R2) and quarantines to D1 and the matchmaker. Failures retry with
   * exponential backoff; nothing is dropped. A cycle delivers at most `outboxPerCycle` items
   * (`drainLeft`, which `cycle` sets), so it writes at most that many `life.ended` points; the
   * rest wait for the next cycle.
   */
  private async drain(): Promise<void> {
    for (let pass = 0; pass < 2; pass++) {
      const meta = this.store.meta();
      if (!meta || this.drainLeft <= 0) return;
      const due = this.store.dueOutbox(Date.now(), meta.openChunkTick, this.drainLeft);
      if (due.length === 0) return;
      this.drainLeft -= due.length;
      for (const { seq, item } of due) {
        try {
          switch (item.kind) {
            case "chunk":
              await this.env.REPLAYS.put(item.key, item.bytes);
              break;
            case "trace":
              await this.putTrace(item.key, item.bytes);
              break;
            case "life": {
              const life = JSON.parse(item.json) as LifeResult;
              await insertLives(this.env.DB, [life]);
              await this.matchmaker().lifeEnded(life);
              writeMetric(this.env.METRICS, "life.ended", {
                versionId: life.versionId,
                deathCause: life.deathCause,
                roomId: life.roomId,
                score: life.score,
                ticks: life.endTick - life.startTick,
                kills: life.kills,
                durationMs: life.endedAt - life.startedAt,
              });
              this.askAgain();
              break;
            }
            case "dropped":
              await this.matchmaker().lifeDropped(JSON.parse(item.json) as LifeDrop);
              this.askAgain();
              break;
            case "quarantine": {
              const record = JSON.parse(item.json) as QuarantineRecord;
              if ((await recordQuarantine(this.env.DB, record)) === "missing") {
                // Terminal: the version was deleted. The room's own quarantine stands.
                log("error", "room.quarantine_missing", { ...record, roomId: meta.roomId });
              }
              await this.matchmaker().versionQuarantined(record);
              break;
            }
            case "kill": {
              const kill = JSON.parse(item.json) as VersionKillRecord;
              const message =
                "Quarantined by the arena for review: across rooms, the CPU backstop named this " +
                `bot's code at least ${VERSION_KILLS_TO_QUARANTINE} times in a week (calls ` +
                "killed by the CPU limit or running past a room's budget; last in room " +
                `${kill.roomId} at tick ${kill.tick}). ${CAUSE}`;
              const { kills, quarantined } = await recordKill(this.env.DB, kill, {
                threshold: VERSION_KILLS_TO_QUARANTINE,
                since: kill.at - VERSION_KILL_WINDOW_MS,
                message,
              });
              // Quarantined by its kills across rooms (not by this room's own count, which
              // notified already): tell the matchmaker, then refuse its tickets here too.
              if (
                quarantined &&
                kills >= VERSION_KILLS_TO_QUARANTINE &&
                !this.store.isQuarantined(kill.versionId)
              ) {
                await this.matchmaker().versionQuarantined({
                  versionId: kill.versionId,
                  author: kill.author,
                  lifeId: kill.lifeId,
                  roomId: kill.roomId,
                  tick: kill.tick,
                  evictions: this.store.evictions().filter((e) => e.versionId === kill.versionId)
                    .length,
                  kills,
                  message,
                  at: kill.at,
                });
                this.store.quarantine(kill.versionId, kill.at);
                this.reportQuarantine("kills", meta.roomId, kill.versionId, 0, kills);
              }
              break;
            }
            case "retract":
              await retractKills(this.env.DB, JSON.parse(item.json) as VersionKillRecord[]);
              break;
            case "closed":
              await this.matchmaker().roomClosed(meta.roomId);
              break;
          }
          this.store.done(seq);
        } catch (e) {
          const attempts = this.store.failed(seq, (a) => Date.now() + retryDelayMs(a), String(e));
          log("error", "room.outbox_failed", {
            roomId: meta.roomId,
            kind: item.kind,
            attempts,
            error: e,
          });
        }
      }
    }
  }

  /**
   * Asks the matchmaker for lives while there is room for them: slots that house snakes hold count
   * as free, since they make way for user lives (`plan`). Returns true when it had none (its queue
   * is empty for us, now or at the last ask).
   */
  private async refill(): Promise<boolean> {
    const meta = this.store.meta();
    if (meta?.state !== "running") return false;
    if (this.superseded() || Date.now() < meta.nextLifeAfter) return true;
    const present: LifeEntry[] = [...this.store.roster(), ...this.store.pending()];
    const excludeAuthors = present.map((p) => p.author);
    let vacancies = meta.maxSnakes - present.filter((p) => p.versionId !== null).length;
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
      if (!result.ok) {
        console.warn("room refused ticket", ticket.lifeId, result.reason);
        this.dropTicket({ ...ticket, house: null }, result.reason);
      } else vacancies--;
      excludeAuthors.push(ticket.author);
    }
    return false;
  }

  /** A report freed a bot: the next refill asks the matchmaker at once. */
  private askAgain(): void {
    if (!this.store.meta()?.nextLifeAfter) return;
    this.store.updateMeta((m) => {
      m.nextLifeAfter = 0;
    });
  }

  /**
   * Idle (only house bots, nothing from the matchmaker), but reports of real lives that ended
   * here are still in the outbox: keep running for `REPORT_GRACE_MS` past a replay chunk, since
   * those bots are likely to come back here once the matchmaker hears of them.
   */
  private awaitingReports(): boolean {
    if (this.paused || !this.store.hasReports()) return false;
    const meta = this.store.meta();
    if (!meta) return false;
    const now = Date.now();
    if (!meta.idleSince) {
      meta.idleSince = now;
      this.store.setMeta(meta);
    }
    return now - meta.idleSince < meta.limits.chunkTicks * TICK_MS + REPORT_GRACE_MS;
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
    const now = Date.now();
    this.flushMetrics(meta, sim.world, now, true);
    const closed = {
      roomId: meta.roomId,
      reason: this.paused ? "kill_switch" : this.superseded() ? "superseded" : "empty",
      ticks: sim.world.tick,
      lives: meta.livesEnded,
      durationMs: meta.startedAt ? now - meta.startedAt : 0,
    };
    this.store.transaction(() => {
      this.store.putJson("world", sim.world);
      this.store.putBlob("chunk", null);
      this.traces.clear();
      for (const c of chunks) this.store.enqueue({ kind: "chunk", ...c });
      this.store.enqueue({ kind: "closed" });
      meta.state = "closed";
      meta.openChunkTick = null;
      this.store.setMeta(meta);
    });
    await this.closed(meta, closed);
  }

  /**
   * Whether the saved world or open replay chunk comes from an older engine, which this one can't
   * run: the round arena before #76 (its config has no `arenaHalfSize`, its chunks are version 1).
   */
  private outdated(): boolean {
    if (this.sim) return false;
    const world = this.store.getJson<World>("world");
    if (world && !(world.config.arenaHalfSize > 0)) return true;
    const chunk = this.store.getBlob("chunk");
    return chunk !== null && replayChunkVersion(chunk) !== REPLAY_VERSION;
  }

  /**
   * Whether the room's world runs on other rules than this engine's defaults: it started before
   * they changed. It then takes no new lives and closes once its real lives have ended (see the
   * class comment). A world's config never changes, so the answer is kept.
   */
  private superseded(): boolean {
    if (this.rulesCurrent === null) {
      const world = this.sim?.world ?? this.store.getJson<World>("world");
      if (!world) return false;
      this.rulesCurrent = sameRules(world.config, DEFAULT_CONFIG);
    }
    return !this.rulesCurrent;
  }

  /**
   * Closes a room `outdated` says the engine can't run (it was running when the engine changed
   * under it). Every life, running or pending, is dropped as if it never started: the matchmaker
   * gives the bot its quota and its place back, and nothing is rated, struck or counted as an
   * eviction. Its open replay chunk is discarded (it couldn't be played). The matchmaker opens
   * new rooms for the bots.
   */
  private async closeOutdated(meta: Meta): Promise<void> {
    const world = this.store.getJson<World>("world");
    const now = Date.now();
    const closed = {
      roomId: meta.roomId,
      reason: "outdated",
      ticks: world?.tick ?? 0,
      lives: meta.livesEnded,
      durationMs: meta.startedAt ? now - meta.startedAt : 0,
    };
    this.store.transaction(() => {
      for (const p of this.store.pending()) {
        if (this.store.removePendingLife(p.lifeId)) this.dropTicket(p, "outdated");
      }
      for (const e of this.store.roster()) {
        this.store.removeFromRoster(e.lifeId);
        this.dropTicket(e, "outdated");
      }
      this.store.putBlob("chunk", null);
      this.store.clearMarker();
      this.traces.clear();
      this.store.enqueue({ kind: "closed" });
      meta.state = "closed";
      meta.openChunkTick = null;
      this.store.setMeta(meta);
    });
    await this.closed(meta, closed);
  }

  /** After `close` or `closeOutdated` committed: report, let spectators go, deliver. */
  private async closed(meta: Meta, closed: MetricFields<"room.closed">): Promise<void> {
    writeMetric(this.env.METRICS, "room.closed", closed);
    log("info", "room.closed", closed);
    this.dropSim();
    this.spectators.closeAll("room closed");
    try {
      await showcase(this.env).remove(this.ctx.id.toString());
    } catch (e) {
      console.error("room showcase remove", meta.roomId, e);
    }
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
    if (this.mode(meta) === "accelerated") {
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

  /**
   * Tells the showcase registry about the room, at most every `SHOWCASE_REPORT_MS` (`showcase.ts`
   * picks the rooms the home page shows from these reports). A room that isn't the showcase (any
   * more: its turn is over) lets its spectators go, so it doesn't stay in real time.
   */
  private async reportShowcase(): Promise<void> {
    const now = Date.now();
    const meta = this.store.meta();
    if (meta?.state !== "running" || meta.manual || now - this.reportedAt < SHOWCASE_REPORT_MS) {
      return;
    }
    this.reportedAt = now;
    const world = this.sim?.world ?? this.store.getJson<World>("world");
    const roster = this.store.roster();
    try {
      const { showcase: shown } = await showcase(this.env).report({
        objectId: this.ctx.id.toString(),
        roomId: meta.roomId,
        tick: world?.tick ?? 0,
        realLives: roster.filter((e) => e.versionId !== null).length,
        snakes: world?.snakes.length ?? 0,
        mass: Math.round((world?.snakes ?? []).reduce((m, s) => m + s.mass, 0)),
        spectators: this.spectators.count,
        at: now,
      });
      if (!shown && this.spectators.count > 0) this.spectators.release("showcase moved");
    } catch (e) {
      console.error("room showcase report", meta.roomId, e);
    }
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
    const sandbox = await this.newLifeStarter();
    this.sim = new RoomSim(
      meta.roomId,
      world,
      chunk ? decodeReplayChunk(chunk) : null,
      sandbox,
      this.store.roster(),
      meta.limits.chunkTicks,
      this.traces.load(),
    );
    return this.sim;
  }

  /** A fresh sandbox per loaded `sim`, with the room's bundles. Tests wrap it. */
  protected async newLifeStarter(): Promise<LifeStarter> {
    return lifeStarter(await createSandbox({ wasmModule }), this.bundles);
  }

  /** Writes a finished life trace (JSON) to R2 `TRACES`, gzipped. Tests make it fail. */
  protected async putTrace(key: string, json: Uint8Array): Promise<void> {
    await this.env.TRACES.put(key, await gzip(json), {
      httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
    });
  }

  /** Instruments a bot bundle (`room/bundles.ts`). Tests slow it down. */
  protected async instrumentBundle(source: string): Promise<InstrumentResult> {
    return instrument(source);
  }

  /** Writes `room.batch` when `metricsMs` passed since the last one (or `force`). */
  private flushMetrics(meta: Meta, world: World, now: number, force = false): void {
    this.metrics.flush(
      this.env.METRICS,
      {
        roomId: meta.roomId,
        mode: this.mode(meta),
        snakes: world.snakes.length,
        spectators: this.spectators.count,
        tick: world.tick,
        realLives: this.store.roster().filter((e) => e.versionId !== null).length,
      },
      now,
      meta.limits.metricsMs ?? METRICS_MS,
      force,
    );
  }

  /** Notes on the batch marker, if any, that the alarm's exception was reported (`recover`). */
  private markReported(): void {
    try {
      const marker = this.store.marker();
      if (marker) this.store.setMarker({ ...marker, exception: true });
    } catch {
      // Storage may be what threw: the recovery then reports the incident a second time.
    }
  }

  private reportQuarantine(
    by: "room" | "kills",
    roomId: string,
    versionId: string,
    evictions: number,
    kills: number,
  ): void {
    const fields = { versionId, by, roomId, evictions, kills };
    writeMetric(this.env.METRICS, "version.quarantined", fields);
    log("warn", "version.quarantined", fields);
  }

  private dropSim(): void {
    this.sim?.dispose();
    this.sim = null;
  }

  /**
   * Whether an admin stopped the arena (`arena_control.paused`), re-read at most every
   * `arenaControlPollMs`. A failed read keeps the last answer.
   */
  private async arenaStopped(meta: Meta): Promise<boolean> {
    const now = Date.now();
    if (now - this.pausedReadAt < meta.limits.arenaControlPollMs) return this.paused;
    try {
      const paused = await arenaPaused(this.env.DB);
      if (paused !== this.paused) console.warn("room arena control", meta.roomId, { paused });
      this.paused = paused;
      this.pausedReadAt = now;
    } catch (e) {
      console.error("room arena control read failed", meta.roomId, e);
    }
    return this.paused;
  }

  /** The arena is stopped: drop the tickets, retire every life at the next batch. */
  private retireAll(): void {
    for (const p of this.store.pending()) {
      if (this.store.removePendingLife(p.lifeId)) this.dropTicket(p, "stopped");
    }
    for (const e of this.store.roster()) {
      if (e.leaving || e.evicted) continue;
      this.store.markLeaving(e.lifeId);
      this.sim?.markLeaving(e.lifeId);
    }
  }

  /** Whether D1 has the ticket's version quarantined (by any room). Fails open: logs, false. */
  private async quarantinedInD1(ticket: LifeTicket): Promise<boolean> {
    try {
      return await isQuarantined(this.env.DB, ticket.versionId);
    } catch (e) {
      console.error("room quarantine read failed", ticket.versionId, e);
      return false;
    }
  }

  /** Tells the matchmaker (through the outbox) that a ticket of a version won't start a life. */
  private dropTicket(ticket: LifeEntry, reason: LifeDrop["reason"]): void {
    const meta = this.store.meta();
    if (!ticket.versionId || !meta) return;
    const drop: LifeDrop = {
      lifeId: ticket.lifeId,
      versionId: ticket.versionId,
      roomId: meta.roomId,
      reason,
      at: Date.now(),
    };
    this.store.enqueue({ kind: "dropped", json: JSON.stringify(drop) });
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

/** What `countIncident` did. */
interface Counted {
  kills: NamedKill[];
  evict: string[];
  versionKills: number;
  outcome: IncidentOutcome;
  /** The version the kill named, if any. */
  versionId: string | null;
}

function stripSeq({ seq: _, ...entry }: PendingEntry): LifeEntry {
  return entry;
}

/** Why a quarantine usually happens, for the people reading `quarantine_reason`. */
const CAUSE =
  "That's usually an operator on huge strings or objects, which the tick budget can't meter.";

function killRecord(meta: Meta, k: VersionKill): VersionKillRecord {
  return {
    id: k.id,
    versionId: k.versionId,
    author: k.author,
    lifeId: k.lifeId,
    roomId: meta.roomId,
    tick: k.tick,
    at: k.at,
  };
}

function evictionDetail(meta: Meta, call: BotCall): string {
  return `${call.kind === "init" ? "starting its life" : "its tick"} at room tick ${call.tick} (${
    meta.limits.cpuLimitMs
  } ms CPU limit)`;
}
