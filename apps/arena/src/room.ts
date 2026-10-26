import { DurableObject } from "cloudflare:workers";
import {
  createWorld,
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
  DEFAULT_MAX_SNAKES,
  DEFAULT_MIN_AUTHORS,
  NEXT_LIFE_RETRY_MS,
  REALTIME_BATCH_TICKS,
  SAFETY_ALARM_MS,
} from "./limits.ts";
import type {
  BanRecord,
  JoinResult,
  LifeResult,
  LifeTicket,
  MatchmakerRpc,
  RoomMode,
  RoomRpc,
  RoomStartOptions,
  RoomStatus,
} from "./protocol.ts";
import { houseFill } from "./room/house.ts";
import { type BatchHooks, type BatchPlan, type BatchResult, RoomSim } from "./room/sim.ts";
import {
  type BatchMarker,
  type LifeEntry,
  type Meta,
  type PendingEntry,
  RoomStore,
} from "./room/store.ts";

/** Outbox items that keep failing are dropped after this many attempts. */
const MAX_OUTBOX_ATTEMPTS = 10;
const TICK_MS = 1000 / TICK_RATE;

/**
 * One persistent room of up to 20 snakes (SPEC §4–5), simulated in batches of ticks from
 * `alarm()`: as fast as the CPU allows (`accelerated`) or at 10 ticks/s (`realtime`).
 *
 * A batch, step by step:
 *  1. plan: spawn the pending tickets (and house bots up to 5 distinct authors), kill banned and
 *     leaving lives; size the batch for the worst case (see `limits.ts`);
 *  2. write a marker and `sync()` it, so a batch that dies is noticed by the next alarm;
 *  3. run it (engine + one QuickJS life per snake, recorded by `ReplayRecorder`);
 *  4. in one transaction: save the world, the open replay chunk and the roster, queue the side
 *     effects (replay chunks for R2, finished lives for D1 and the matchmaker), clear the marker;
 *  5. drain the outbox, ask the matchmaker for replacements, schedule the next alarm.
 *
 * Backstop: a marker left over means the batch died (DO CPU limit, eviction, exception). The room
 * reloads the saved world and replays the same batch one bot at a time, syncing "who is running"
 * to storage before each bot's code. If that dies too, the bot named in the marker is the
 * culprit: its version is banned and its snake killed. If it completes, the incident is logged as
 * inconclusive and its result kept.
 *
 * After any reload (eviction or backstop) every bot restarts with `init` and empty memory;
 * the world, replay and roster continue exactly.
 */
export class RoomDO extends DurableObject<Env> implements RoomRpc {
  private readonly store: RoomStore;
  private sim: RoomSim | null = null;
  private busy = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new RoomStore(ctx.storage);
  }

  // --- RPC ---------------------------------------------------------------------------------

  async start(options: RoomStartOptions = {}): Promise<RoomStatus> {
    if (!this.store.meta()) {
      const seed = options.seed ?? crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
      const world = createWorld({ seed });
      const meta: Meta = {
        roomId: options.roomId ?? crypto.randomUUID(),
        state: "running",
        mode: options.mode ?? "accelerated",
        maxSnakes: options.maxSnakes ?? DEFAULT_MAX_SNAKES,
        minAuthors: options.minAuthors ?? DEFAULT_MIN_AUTHORS,
        manual: options.manual ?? false,
        livesEnded: 0,
        lastBatchTicks: 0,
        nextLifeAfter: 0,
        realtimeNext: 0,
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
    const meta = this.store.meta();
    if (!meta || meta.mode === mode) return;
    meta.mode = mode;
    meta.realtimeNext = Date.now();
    this.store.setMeta(meta);
    if (meta.state !== "running" || meta.manual) return;
    // Switching to accelerated runs the next batch now; to real time, from now on.
    await this.ctx.storage.setAlarm(Date.now());
  }

  async status(): Promise<RoomStatus> {
    const meta = this.store.meta();
    const world = this.sim?.world ?? this.store.getJson<World>("world");
    const snakes = new Map((world?.snakes ?? []).map((s) => [s.id, s]));
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
      incidents: this.store.incidents(),
      bans: this.store.bans().map((b) => b.versionId),
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
    try {
      const meta = this.store.meta();
      if (meta?.state !== "running") return;
      try {
        const marker = this.store.marker();
        if (marker) await this.recover(meta, marker);
        else await this.batch(meta);
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

  private async batch(meta: Meta, ticks?: number): Promise<void> {
    const sim = await this.loadSim(meta);
    const maxPendingSeq = this.store.lastPendingSeq();
    const plan = this.plan(meta, sim, maxPendingSeq, ticks);
    await this.begin({
      fromTick: sim.world.tick,
      ticks: plan.ticks,
      maxPendingSeq,
      isolate: false,
      suspectLife: null,
      suspectTick: null,
    });
    const result = await sim.run(plan);
    this.commit(meta, sim, plan, result, maxPendingSeq);
  }

  /** A batch died before saving its result (the marker is still there). */
  private async recover(meta: Meta, marker: BatchMarker): Promise<void> {
    this.dropSim();
    const now = Date.now();
    if (marker.isolate) {
      // The isolated replay died too: whoever's code was running did it.
      const culprit = marker.suspectLife ? this.findLife(marker.suspectLife) : null;
      this.store.transaction(() => {
        if (culprit?.versionId) {
          const ban: BanRecord = {
            versionId: culprit.versionId,
            author: culprit.author,
            lifeId: culprit.lifeId,
            roomId: meta.roomId,
            tick: marker.suspectTick ?? marker.fromTick,
            reason: "cpu",
            message:
              `The room ran out of CPU twice in ticks ${marker.fromTick}–` +
              `${marker.fromTick + marker.ticks}; the second time, with one bot running at a ` +
              `time, it was this bot's code (tick ${marker.suspectTick}).`,
            at: now,
          };
          this.store.addBan({ ...ban });
          this.store.enqueue({ kind: "ban", json: JSON.stringify(ban) });
        } else if (culprit) {
          this.store.markLeaving(culprit.lifeId);
        }
        this.store.addIncident(
          {
            tick: marker.fromTick,
            outcome: culprit ? "banned" : "inconclusive",
            versionId: culprit?.versionId ?? null,
          },
          now,
        );
        this.store.clearMarker();
      });
      console.error("room backstop", meta.roomId, marker, culprit?.versionId ?? "no culprit");
      await this.batch(meta);
      return;
    }

    // Replay the same batch from the saved world, one bot at a time.
    console.warn("room batch died, replaying it isolated", meta.roomId, marker);
    const sim = await this.loadSim(meta);
    const plan = this.plan(meta, sim, marker.maxPendingSeq, marker.ticks);
    await this.begin({ ...marker, isolate: true, suspectLife: null, suspectTick: null });
    const hooks: BatchHooks = {
      beforeBot: async (lifeId, tick) => {
        this.store.setSuspect(lifeId, tick);
        await this.ctx.storage.sync();
      },
    };
    const result = await sim.run(plan, hooks);
    this.commit(meta, sim, plan, result, marker.maxPendingSeq, () => {
      this.store.addIncident(
        { tick: marker.fromTick, outcome: "inconclusive", versionId: null },
        now,
      );
    });
  }

  /** What the next batch does. Depends only on saved state, so a replay plans the same batch. */
  private plan(meta: Meta, sim: RoomSim, maxPendingSeq: number, ticks?: number): BatchPlan {
    const faults = new Map<string, Fault>();
    for (const e of sim.roster) {
      if (e.versionId && this.store.isBanned(e.versionId)) faults.set(e.lifeId, "timeout");
      else if (e.leaving) faults.set(e.lifeId, "error");
    }
    const staying: LifeEntry[] = sim.roster.filter((e) => !faults.has(e.lifeId));
    const spawns: LifeEntry[] = [];
    for (const p of this.store.pending(maxPendingSeq)) {
      const taken = [...staying, ...spawns].some((e) => e.author === p.author);
      const banned = p.versionId !== null && this.store.isBanned(p.versionId);
      if (taken || banned || staying.length + spawns.length >= meta.maxSnakes) {
        console.warn("room drops ticket", p.lifeId, { taken, banned });
        continue;
      }
      spawns.push(stripSeq(p));
    }
    spawns.push(
      ...houseFill([...staying, ...spawns], meta.maxSnakes, meta.minAuthors, sim.world.tick),
    );
    const bots = staying.length + spawns.length;
    const starts = spawns.length + sim.idleLives;
    let n = ticks ?? batchTicks(bots, starts);
    if (ticks === undefined && meta.mode === "realtime") n = Math.min(n, REALTIME_BATCH_TICKS);
    return { spawns, faults, ticks: n };
  }

  /** Saves the marker (and a safety alarm) durably before a batch runs. */
  private async begin(marker: BatchMarker): Promise<void> {
    const meta = this.store.meta();
    this.store.setMarker(marker);
    if (meta && !meta.manual) await this.ctx.storage.setAlarm(Date.now() + SAFETY_ALARM_MS);
    await this.ctx.storage.sync();
  }

  private commit(
    meta: Meta,
    sim: RoomSim,
    plan: BatchPlan,
    result: BatchResult,
    maxPendingSeq: number,
    alsoInTransaction?: () => void,
  ): void {
    const now = Date.now();
    this.store.transaction(() => {
      alsoInTransaction?.();
      const pending = sim.recorder.pending;
      this.store.putJson("world", sim.world);
      this.store.putBlob("chunk", pending ? encodeReplayChunk(pending) : null);
      for (const s of result.spawned) this.store.addToRoster(s);
      this.store.removePending(maxPendingSeq);
      let real = 0;
      for (const { entry, death, killer } of result.ended) {
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
          deathCause: entry.leaving ? "retired" : death.cause,
          killer: killer ? (killer.versionId ?? `house:${killer.house}`) : null,
          replayKey: entry.replayKey,
          startedAt: entry.startedAt,
          endedAt: now,
        };
        this.store.enqueue({ kind: "life", json: JSON.stringify(life) });
      }
      for (const c of result.chunks) this.store.enqueue({ kind: "chunk", ...c });
      const fresh = this.store.meta() ?? meta;
      fresh.livesEnded += result.ended.length;
      fresh.lastBatchTicks = plan.ticks;
      if (real > 0) fresh.nextLifeAfter = 0;
      this.store.setMeta(fresh);
      this.store.clearMarker();
    });
  }

  // --- Side effects ------------------------------------------------------------------------

  /** Sends what committed batches queued: replay chunks to R2, lives and bans to D1. */
  private async drain(): Promise<void> {
    const meta = this.store.meta();
    for (const { seq, item } of this.store.outbox()) {
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
            await recordBan(this.env.DB, ban);
            await this.matchmaker().versionBanned(ban);
            break;
          }
          case "closed":
            if (meta) await this.matchmaker().roomClosed(meta.roomId);
            break;
        }
        this.store.done(seq);
      } catch (e) {
        const attempts = this.store.failed(seq);
        console.error("room outbox", item.kind, `attempt ${attempts}`, e);
        if (attempts >= MAX_OUTBOX_ATTEMPTS) this.store.done(seq);
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
        const fresh = this.store.meta() ?? meta;
        fresh.nextLifeAfter = Date.now() + NEXT_LIFE_RETRY_MS;
        this.store.setMeta(fresh);
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
      this.store.setMeta(meta);
    });
    this.dropSim();
    await this.ctx.storage.deleteAlarm();
    await this.drain();
  }

  // --- Scheduling --------------------------------------------------------------------------

  /** Makes sure a batch runs soon (a ticket arrived). */
  private async kick(meta: Meta): Promise<void> {
    if (meta.manual || meta.state !== "running") return;
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
  }

  private async scheduleNext(): Promise<void> {
    const meta = this.store.meta();
    if (!meta || meta.manual || meta.state !== "running") {
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
