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
import { ARENA_CONTROL_POLL_MS } from "@zerosnake/web/shared";
// Wrangler only treats specifiers ending in .wasm as compiled modules; the package's "./wasm"
// export doesn't, so the file is imported by path.
import wasmModule from "../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm";
import { arenaPaused, insertLives, isQuarantined, recordQuarantine } from "./db.ts";
import {
  batchTicks,
  DEFAULT_MAX_OUTBOX,
  DEFAULT_MAX_SNAKES,
  DEFAULT_MIN_AUTHORS,
  DO_CPU_LIMIT_MS,
  NEXT_LIFE_RETRY_MS,
  REALTIME_BATCH_TICKS,
  ROOM_CPU_BUDGET_MS,
  SAFETY_ALARM_MS,
} from "./limits.ts";
import type {
  IncidentOutcome,
  JoinResult,
  LifeResult,
  LifeTicket,
  MatchmakerRpc,
  QuarantineRecord,
  RoomMode,
  RoomRpc,
  RoomStartOptions,
  RoomStatus,
} from "./protocol.ts";
import {
  ageKills,
  type BotCall,
  DEFAULT_WATCH_GAP_MS,
  EVICTIONS_TO_QUARANTINE,
  INCIDENT_WINDOW_MS,
  judgeCrash,
  nextKills,
  ROOM_KILLS_TO_EVICT,
  retryDelayMs,
  WATCH_ABORT_SHARE,
  WATCH_GAP_CAP_SHARE,
  WATCH_STOP_SHARE,
  WATCH_WALL_SHARE,
  watchGapMs,
  watching,
  watchWindow,
} from "./room/backstop.ts";
import { houseFill } from "./room/house.ts";
import {
  type BatchHooks,
  type BatchPlan,
  type BatchResult,
  chunkKey,
  type LifeStarter,
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

const TICK_MS = 1000 / TICK_RATE;

/**
 * One persistent room of up to 20 snakes (SPEC §4–5), simulated in batches of ticks from
 * `alarm()`: as fast as the CPU allows (`accelerated`) or at 10 ticks/s (`realtime`).
 *
 * A batch, step by step:
 *  1. plan: spawn the pending tickets (and house bots up to 5 distinct authors), kill evicted and
 *     leaving lives; size the batch for the worst case (see `limits.ts`);
 *  2. write a marker with the invocation's start time and `sync()` it, so a batch that dies is
 *     noticed by the next alarm;
 *  3. run it (engine + one QuickJS life per snake, recorded by `ReplayRecorder`);
 *  4. in one transaction: save the world, the open replay chunk and the roster, queue the side
 *     effects (replay chunks for R2, finished lives for D1 and the matchmaker), clear the marker;
 *  5. deliver the outbox, ask the matchmaker for replacements, schedule the next alarm.
 *
 * Backstop (`room/backstop.ts`): a marker left over means the batch died. If too little wall time
 * passed for it to have been the CPU limit, it was a restart: the batch runs again and counts for
 * nothing. Otherwise the room switches to watch mode (each bot call made durable, a random wait
 * after it, batches stopped early) for a window that grows with repeated incidents. Nobody is ever
 * struck or banned for a kill: a life that watched kills keep naming is evicted (neutral end, not
 * rated) so the room makes progress (the kill window, `backstop.ts`), and a version evicted
 * `EVICTIONS_TO_QUARANTINE` times is quarantined for every room (`versions.quarantined_at` in D1).
 *
 * The arena's kill switch (`arena_control.paused` in D1, re-read every `ARENA_CONTROL_POLL_MS`):
 * while it's on, the room starts no lives, retires the running ones and closes.
 *
 * After any reload (eviction or crash) every bot restarts with `init` and empty memory; the
 * world, replay and roster continue exactly.
 */
export class RoomDO extends DurableObject<Env> implements RoomRpc {
  private readonly store: RoomStore;
  private sim: RoomSim | null = null;
  private busy = false;
  /** The kill switch as last read from D1, and when (wall ms; in memory only). */
  private paused = false;
  private pausedReadAt = 0;

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
          cpuBudgetMs:
            limits.cpuBudgetMs ??
            Math.min(ROOM_CPU_BUDGET_MS, limits.cpuLimitMs ?? DO_CPU_LIMIT_MS),
          batchTicks: limits.batchTicks ?? 0,
          maxOutbox: limits.maxOutbox ?? DEFAULT_MAX_OUTBOX,
          chunkTicks: limits.chunkTicks ?? CHUNK_TICKS,
          watchGapMs: limits.watchGapMs ?? DEFAULT_WATCH_GAP_MS,
          arenaControlPollMs: limits.arenaControlPollMs ?? ARENA_CONTROL_POLL_MS,
        },
        livesEnded: 0,
        lastBatchTicks: 0,
        nextLifeAfter: 0,
        realtimeNext: 0,
        watch: { untilTick: 0, untilMs: 0 },
        openChunkTick: null,
        kills: [],
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
    if (meta?.state !== "running" || this.paused) return { ok: false, reason: "closed" };
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
      evictions: this.store
        .evictions()
        .map(({ versionId, lifeId, tick }) => ({ versionId, lifeId, tick })),
      quarantined: this.store.quarantined(),
      kills: meta?.kills ?? [],
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
      if (await this.arenaStopped(meta)) this.retireAll();
      try {
        const marker = this.store.marker();
        if (marker) await this.recover(meta, marker, invokedAt);
        else await this.batch(invokedAt);
      } catch (e) {
        // The in-memory room may be half a batch ahead of storage: drop it. The marker stays,
        // so the next cycle handles this like a batch that died.
        this.dropSim();
        throw e;
      }
      await this.drain();
      const queueEmpty = this.paused || (await this.refill());
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
      fromTick: sim.world.tick,
      maxPendingSeq,
      startedAt: invokedAt,
      watch,
      call: null,
    };
    await this.begin(meta, marker);
    const result = await sim.run(plan, watch ? this.watchHooks(meta, marker) : {});
    this.commit(sim, result, maxPendingSeq);
    // Some bots ran a tick the world never stepped: restart them from the saved frame.
    if (result.aborted) this.dropSim();
  }

  /**
   * Watch mode: before each bot call, make "this call is running" durable, and stop the batch at
   * shares of the room's CPU budget (wall time minus the random waits bounds its CPU from above).
   * While the kill window holds a kill (a watched kill named a life), also make "between calls"
   * durable after each call and wait a random while (wall time only), so most of the batch's wall
   * time is between calls and a restart rarely names a life again. Without one that isn't needed:
   * a kill only names a call that ran for most of the CPU limit, which restarts in production
   * practically never look like.
   */
  private watchHooks(meta: Meta, marker: BatchMarker): BatchHooks {
    // The room's budget, not the hard limit: an honest watched invocation stays far below it.
    const limit = meta.limits.cpuBudgetMs;
    const decorrelate = (meta.kills ?? []).length > 0;
    let callAt = 0;
    let slept = 0;
    let first = true;
    const busy = () => Date.now() - marker.startedAt - slept;
    const wait = async (ms: number) => {
      await new Promise((r) => setTimeout(r, ms));
      slept += ms;
    };
    return {
      shuffleStarts: decorrelate,
      continueBatch: () =>
        busy() < WATCH_STOP_SHARE * limit &&
        Date.now() - marker.startedAt < WATCH_WALL_SHARE * limit,
      beforeBot: async (lifeId, kind, tick) => {
        if (decorrelate && first) await wait(Math.random() * WATCH_GAP_CAP_SHARE * limit);
        first = false;
        // Any I/O moves the clock (the engine step since the last one was CPU); a timer is cheapest.
        await new Promise((r) => setTimeout(r, 0));
        callAt = Date.now();
        if (kind === "tick" && busy() > WATCH_ABORT_SHARE * limit) return "abort";
        marker.call = { lifeId, kind, tick, at: callAt, before: busy() };
        this.store.setMarker(marker);
        await this.ctx.storage.sync();
        return "go";
      },
      afterBot: async () => {
        if (!decorrelate) return;
        marker.call = null;
        this.store.setMarker(marker);
        await this.ctx.storage.sync();
        await wait(watchGapMs(Date.now() - callAt, meta.limits.watchGapMs, Math.random(), limit));
      },
    };
  }

  /**
   * A batch died before saving its result (the marker is still there). Count it toward evicting
   * the life whose call it interrupted (the kill window), watch the room, and run the batch again
   * from the saved frame (every bot restarts there).
   */
  private async recover(meta: Meta, marker: BatchMarker, invokedAt: number): Promise<void> {
    this.dropSim();
    const now = Date.now();
    const verdict = judgeCrash(marker, now, meta.limits.cpuLimitMs);
    const named = verdict.kind === "suspect" ? this.findLife(verdict.call.lifeId) : null;
    const { kills, evict } = nextKills(meta.kills ?? [], verdict, marker.watch, marker.fromTick);
    this.store.transaction(() => {
      this.store.clearMarker();
      let outcome: IncidentOutcome = verdict.kind;
      if (verdict.kind === "suspect") {
        const call = verdict.call;
        for (const lifeId of evict) {
          const life = lifeId === named?.lifeId ? named : this.findLife(lifeId);
          if (!life) continue;
          // A life's own count keeps the window; the room's cap empties it.
          const detail =
            evict.length === 1 && kills.length > 0
              ? evictionDetail(meta, call)
              : `one of the bots whose calls ${ROOM_KILLS_TO_EVICT} kills in a row interrupted, ` +
                `last at room tick ${call.tick} (${meta.limits.cpuLimitMs} ms CPU limit)`;
          this.evict(meta, life, call.tick, detail, now);
          if (lifeId === named?.lifeId) outcome = "evicted";
        }
      }
      this.store.addIncident({
        tick: marker.fromTick,
        outcome,
        versionId: named?.versionId ?? null,
        at: now,
      });
      if (verdict.kind === "restart") return;
      const recent = this.store.cpuIncidentsSince(now - INCIDENT_WINDOW_MS);
      this.store.updateMeta((m) => {
        m.kills = kills;
        m.watch = watchWindow(m.watch, recent, marker.fromTick, now, DEFAULT_CONFIG.lifeCap);
      });
    });
    console.error("room batch died", meta.roomId, verdict, { kills, evict });
    await this.batch(invokedAt);
  }

  /**
   * Ends `life` with the neutral cause `evicted` (at the next batch, without running its code
   * again; a pending ticket is dropped), and quarantines its version after
   * `EVICTIONS_TO_QUARANTINE` evictions in this room. Runs inside a transaction.
   */
  private evict(meta: Meta, life: LifeEntry, tick: number, detail: string, now: number): void {
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
        this.store.enqueue({ kind: "life", json: JSON.stringify(result), chunkTick });
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
    console.warn("room evicted", meta.roomId, life.lifeId, versionId, detail);
    if (!versionId || evictions < EVICTIONS_TO_QUARANTINE || this.store.isQuarantined(versionId)) {
      return;
    }
    this.store.quarantine(versionId, now);
    const record: QuarantineRecord = {
      versionId,
      author: life.author,
      lifeId: life.lifeId,
      roomId: meta.roomId,
      tick,
      evictions,
      message:
        "Quarantined by the arena for review: the room's CPU limit kept cutting its runs short " +
        `inside this bot's code, so ${evictions} of its lives were evicted (last: ${detail}). ` +
        "That's usually an operator on huge strings or objects, which the tick budget can't meter.",
      at: now,
    };
    this.store.enqueue({ kind: "quarantine", json: JSON.stringify(record) });
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
    // The engine has no `evicted` cause: the replay shows `error`, the life result `evicted`.
    for (const e of roster) if (e.evicted || e.leaving) faults.set(e.lifeId, "error");
    const staying: LifeEntry[] = roster.filter((e) => !faults.has(e.lifeId));
    const spawns: LifeEntry[] = [];
    for (const p of this.store.pending(maxPendingSeq)) {
      const taken = [...staying, ...spawns].some((e) => e.author === p.author);
      const quarantined = p.versionId !== null && this.store.isQuarantined(p.versionId);
      if (taken || quarantined || staying.length + spawns.length >= meta.maxSnakes) {
        console.warn("room drops ticket", p.lifeId, { taken, quarantined });
        continue;
      }
      spawns.push(stripSeq(p));
    }
    // House bots keep real lives company; with none (the arena stopped), the room closes.
    if ([...staying, ...spawns].some((e) => e.versionId !== null)) {
      spawns.push(...houseFill([...staying, ...spawns], meta.maxSnakes, meta.minAuthors, tick));
    }
    const bots = staying.length + spawns.length;
    const starts = spawns.length + idleLives;
    let ticks = meta.limits.batchTicks || batchTicks(bots, starts, meta.limits.cpuBudgetMs);
    if (meta.mode === "realtime") ticks = Math.min(ticks, REALTIME_BATCH_TICKS);
    return { spawns, faults, ticks };
  }

  /** Saves the marker (and a safety alarm) durably before a batch runs. */
  private async begin(meta: Meta, marker: BatchMarker): Promise<void> {
    this.store.setMarker(marker);
    if (!meta.manual) await this.ctx.storage.setAlarm(Date.now() + SAFETY_ALARM_MS);
    await this.ctx.storage.sync();
  }

  private commit(sim: RoomSim, result: BatchResult, maxPendingSeq: number): void {
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
          deathCause: entry.evicted ? "evicted" : entry.leaving ? "retired" : death.cause,
          killer: killer ? (killer.versionId ?? `house:${killer.house}`) : null,
          replayKey: chunkKey(meta.roomId, chunkTick),
          startedAt: entry.startedAt,
          endedAt: now,
        };
        this.store.enqueue({ kind: "life", json: JSON.stringify(life), chunkTick });
      }
      meta.livesEnded += result.ended.length;
      meta.lastBatchTicks = result.ticks;
      meta.openChunkTick = sim.openChunkTick;
      if (real > 0) meta.nextLifeAfter = 0;
      // Progress ages kills out of the window.
      meta.kills = ageKills(meta.kills ?? [], sim.world.tick);
      this.store.setMeta(meta);
      this.store.clearMarker();
    });
  }

  // --- Side effects ------------------------------------------------------------------------

  /**
   * Delivers what committed batches queued: replay chunks to R2, lives (once their chunk is in
   * R2) and quarantines to D1 and the matchmaker. Failures retry with exponential backoff;
   * nothing is dropped.
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
            case "quarantine": {
              const record = JSON.parse(item.json) as QuarantineRecord;
              if ((await recordQuarantine(this.env.DB, record)) === "missing") {
                // Terminal: the version was deleted. The room's own quarantine stands.
                console.error("room quarantine: version row missing in D1", meta.roomId, record);
              }
              await this.matchmaker().versionQuarantined(record);
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
    const sandbox = await this.newSandbox();
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

  /** The sandbox bots run in (one per loaded room). Tests wrap it. */
  protected newSandbox(): Promise<LifeStarter> {
    return createSandbox({ wasmModule });
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
    for (const p of this.store.pending()) this.store.removePendingLife(p.lifeId);
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

function evictionDetail(meta: Meta, call: BotCall): string {
  return `${call.kind === "init" ? "starting its life" : "its tick"} at room tick ${call.tick} (${
    meta.limits.cpuLimitMs
  } ms CPU limit)`;
}
