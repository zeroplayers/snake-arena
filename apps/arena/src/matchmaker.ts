import { DurableObject } from "cloudflare:workers";
import type { ActiveVersionChange, ArenaControl, MatchmakerSiteRpc } from "@zerosnake/web/shared";
import { arenaPaused, recordQuarantine } from "./db.ts";
import {
  DAY_MS,
  DEFAULT_MATCHMAKER_CONFIG,
  LEAVE_RETRY_MAX_MS,
  LEAVE_RETRY_MS,
  LEAVES_PER_ALARM,
  type MatchmakerConfig,
  NEXT_LIFE_ATTEMPTS,
  PAGE_ROWS,
  PRUNE_ROWS,
  ROOM_CHECKS_PER_ALARM,
  roomsToOpen,
  SOURCE_CACHE_SIZE,
  utcDay,
} from "./matchmaker/config.ts";
import {
  livesStartedSince,
  maxChangeSeq,
  playableVersions,
  versionChanges,
  versionsById,
} from "./matchmaker/d1.ts";
import { MatchmakerStore, type QueuedBot, type RoomState } from "./matchmaker/store.ts";
import type {
  JoinResult,
  LifeDrop,
  LifeResult,
  LifeTicket,
  MatchmakerRpc,
  QuarantineRecord,
  RoomRpc,
  RoomStatus,
} from "./protocol.ts";
import { EVICTIONS_TO_QUARANTINE, VERSION_KILL_WINDOW_MS } from "./room/backstop.ts";

/** Evictions of a version count toward its quarantine for this long (like its named kills). */
const EVICTION_WINDOW_MS = VERSION_KILL_WINDOW_MS;

export interface MatchmakerStatus {
  /** The arena's kill switch, as last read. */
  paused: boolean;
  /** `versions.change_seq` applied so far; null before the first start. */
  cursor: number | null;
  /** A full reconcile from D1 is in progress. */
  reconciling: boolean;
  /** UTC day number of the quotas. */
  day: number;
  /** Bots with a playable version. */
  playable: number;
  /** Bots whose next life can be issued now (quota left, none in flight). */
  waiting: number;
  /** Lives handed to rooms and not reported back yet. */
  issued: number;
  rooms: { roomId: string; state: RoomState; lives: number }[];
}

/**
 * Single global instance (`idFromName(MATCHMAKER_NAME)`) holding the queue of pending lives
 * (SPEC §4). D1 is the source of truth for which version of a bot plays (apps/web
 * `src/shared/arena.ts`); this object keeps, in its SQLite storage:
 *
 * - **the queue**: one row per bot with a playable version (`ready`, not quarantined, not banned
 *   or archived), in round-robin order: a bot's next life goes to the back when its life ends, so
 *   every bot gets a turn before any gets two, and a bot skipped for a room (its author is there)
 *   keeps its place. A bot has at most one life at a time.
 * - **the ledger** of every life it issued, which makes the daily quota exact
 *   (`livesPerBotPerDay` per bot and UTC day): a life counts when issued, and stops counting only
 *   if the room reports it never ran (`lifeDropped`). Reports are at least once, so each is keyed by
 *   `lifeId` and moves a life's state only forward. On its very first start the matchmaker seeds
 *   today's usage from D1's `lives`.
 * - **the rooms** it opened.
 *
 * Rooms pull lives (`nextLife`, never an author already in the room) and report them back
 * (`lifeEnded`, `lifeDropped`). The alarm loop (every `pollMs`, bounded work each time):
 *
 *  1. re-reads the kill switch (`arena_control`) every `arenaControlPollMs`;
 *  2. applies version changes after its `change_seq` cursor (activations by the checks consumer,
 *     rollbacks, archives, bans, quarantines), a page at a time; every `reconcileMs` it re-reads
 *     all playable versions (paged) and stops bots it didn't see (deleted accounts);
 *  3. asks rooms to retire lives of versions that can't play any more (`RoomRpc.leave`), or of
 *     every version while the arena is stopped (rooms then close by themselves), again with
 *     backoff while a room can't act on it yet;
 *  4. opens rooms when more lives wait than `openThreshold` (one if lives wait and none is open),
 *     filling each with up to `maxSnakes` lives of distinct authors, after a fresh read of the
 *     kill switch (none if it can't be read);
 *  5. compares rooms' lives with the ledger (`status()`), so a life nobody reported for
 *     `lostAfterMs` frees its bot;
 *  6. forgets ledger rows older than yesterday, and evictions older than `EVICTION_WINDOW_MS`.
 *
 * Rooms close by themselves when only house bots remain and `nextLife` has nothing for them.
 */
export class MatchmakerDO extends DurableObject<Env> implements MatchmakerRpc, MatchmakerSiteRpc {
  private readonly store: MatchmakerStore;
  /** Bundles by R2 key, least recently used first. */
  private readonly sources = new Map<string, string>();
  private running: Promise<TickReport> | null = null;
  private queued: Promise<TickReport> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new MatchmakerStore(ctx.storage);
    void ctx.blockConcurrencyWhile(() => this.ensureAlarm());
  }

  /** Wall-clock ms. Tests move it (quota days, lost lives). */
  protected now(): number {
    return Date.now();
  }

  /** Defaults under `configure`'s overrides. Tests make them manual. */
  protected baseConfig(): MatchmakerConfig {
    return DEFAULT_MATCHMAKER_CONFIG;
  }

  private config(): MatchmakerConfig {
    return { ...this.baseConfig(), ...this.store.configOverrides() };
  }

  // --- Tools -------------------------------------------------------------------------------

  /** Also (re)starts the alarm loop: the arena's cron calls it. */
  async ping(): Promise<string> {
    await this.ensureAlarm();
    return "matchmaker:ok";
  }

  /** Overrides tunables (merged into earlier overrides); returns the result. */
  async configure(overrides: Partial<MatchmakerConfig>): Promise<MatchmakerConfig> {
    this.store.setConfigOverrides({ ...this.store.configOverrides(), ...overrides });
    await this.ensureAlarm();
    return this.config();
  }

  async status(): Promise<MatchmakerStatus> {
    const c = this.config();
    const meta = this.store.meta();
    const day = utcDay(this.now());
    return {
      paused: meta.paused,
      cursor: meta.cursor,
      reconciling: meta.sweep !== null,
      day,
      playable: this.store.countPlayable(),
      waiting: this.store.countWaiting(day, c.livesPerBotPerDay),
      issued: this.store.countIssued(),
      rooms: this.store.rooms(["opening", "open", "closed"]).map((r) => ({
        roomId: r.roomId,
        state: r.state,
        lives: this.store.issuedIn(r.roomId).length,
      })),
    };
  }

  /**
   * Runs the alarm's work now (what the alarm does). Calls overlapping a run share the next one,
   * so the work never runs twice at once.
   */
  async tick(): Promise<TickReport> {
    if (this.queued) return this.queued;
    if (!this.running) {
      this.running = this.work().finally(() => {
        this.running = null;
      });
      return this.running;
    }
    this.queued = this.running
      .catch(() => {})
      .then(() => {
        this.queued = null;
        return this.tick();
      });
    return this.queued;
  }

  override async alarm(): Promise<void> {
    let more = false;
    try {
      more = (await this.tick()).more;
    } catch (e) {
      console.error("matchmaker alarm", e);
    }
    const c = this.config();
    if (!c.manual) await this.ctx.storage.setAlarm(Date.now() + (more ? 0 : c.pollMs));
  }

  // --- Room → matchmaker -------------------------------------------------------------------

  async nextLife(request: {
    roomId: string;
    excludeAuthors: string[];
  }): Promise<LifeTicket | null> {
    const c = this.config();
    const meta = this.store.meta();
    if (meta.paused || meta.cursor === null) return null;
    const { roomId } = request;
    if (this.store.room(roomId)?.state !== "open") {
      // A room it didn't open (a tool's), or one it thought closed: it's running, so adopt it.
      this.store.setRoom(roomId, "open", this.now());
    }
    for (let attempt = 0; attempt < NEXT_LIFE_ATTEMPTS; attempt++) {
      const exclude = [
        ...request.excludeAuthors,
        ...this.store.issuedIn(roomId).map((l) => l.author),
      ];
      const day = utcDay(this.now());
      const [bot] = this.store.waiting(day, c.livesPerBotPerDay, exclude, 1);
      if (!bot) return null;
      const [ticket] = await this.issue(roomId, [bot]);
      if (ticket) return ticket;
    }
    return null;
  }

  async lifeEnded(result: LifeResult): Promise<void> {
    const now = this.now();
    const since = now - EVICTION_WINDOW_MS;
    const evictions = this.store.transaction(() => {
      if (!this.store.endLife(result.lifeId, result.deathCause, now)) {
        console.warn("matchmaker: lifeEnded for a life it didn't issue", result.lifeId);
      }
      if (result.deathCause !== "evicted") return null;
      const at = Math.min(result.endedAt, now);
      const counted = this.store.addEviction(
        result.lifeId,
        result.versionId,
        result.roomId,
        at,
        since,
      );
      // A redelivered report quarantines only if the first one's quarantine didn't go through
      // (the version still plays): its count can't have grown.
      const quarantine =
        counted.count >= EVICTIONS_TO_QUARANTINE &&
        (counted.added || this.store.plays(result.versionId));
      return quarantine ? counted.count : null;
    });
    if (evictions !== null) await this.quarantineEvicted(result, evictions, since, now);
  }

  async lifeDropped(drop: LifeDrop): Promise<void> {
    if (!this.store.dropLife(drop.lifeId, this.now())) {
      console.warn("matchmaker: lifeDropped for a life it didn't issue", drop.lifeId);
    }
    // D1 has it quarantined and the poll hasn't caught up: catch up now.
    if (drop.reason === "quarantined") await this.kick();
  }

  async versionQuarantined(record: QuarantineRecord): Promise<void> {
    console.warn("matchmaker: version quarantined", record.versionId, record.roomId);
    this.store.disableVersion(record.versionId);
  }

  async roomClosed(roomId: string): Promise<void> {
    this.store.setRoom(roomId, "closed", this.now());
  }

  // --- Site → matchmaker (hints: the alarm loop finds the same in D1) ------------------------

  async activeVersionChanged(change: ActiveVersionChange): Promise<void> {
    console.log("matchmaker: active version changed", change.botId, change.reason);
    await this.tick();
  }

  async arenaControlChanged(control: ArenaControl): Promise<void> {
    console.log("matchmaker: arena control changed", { paused: control.paused });
    this.store.updateMeta((m) => {
      m.pausedReadAt = 0;
    });
    await this.tick();
  }

  // --- The alarm's work --------------------------------------------------------------------

  private async work(): Promise<TickReport> {
    const c = this.config();
    await this.readArenaControl(c, false);
    if (this.store.meta().cursor === null) await this.bootstrap();
    let more = await this.pollChanges();
    if (await this.reconcile(c)) more = true;
    if (this.store.meta().paused) this.store.retireAll();
    if (await this.sendLeaves()) more = true;
    if (!this.store.meta().paused && (await this.openRooms(c))) more = true;
    await this.checkRooms(c);
    const now = this.now();
    this.store.prune(utcDay(now), now, now - EVICTION_WINDOW_MS, PRUNE_ROWS);
    return { more };
  }

  /** First start: the cursor at D1's latest change, today's usage from `lives`, a full reconcile. */
  private async bootstrap(): Promise<void> {
    const cursor = await maxChangeSeq(this.env.DB);
    const day = utcDay(this.now());
    const used = await livesStartedSince(this.env.DB, day * DAY_MS);
    this.store.transaction(() => {
      for (const u of used) this.store.seedUsage(u.botId, day, u.lives);
      this.store.updateMeta((m) => {
        m.cursor = cursor;
        m.gen++;
        m.sweep = { after: "" };
      });
    });
    console.log("matchmaker: started", { cursor, botsWithLivesToday: used.length });
  }

  /** Applies a page of version changes after the cursor. Returns whether more may follow. */
  private async pollChanges(): Promise<boolean> {
    const cursor = this.store.meta().cursor;
    if (cursor === null) return false;
    const rows = await versionChanges(this.env.DB, cursor, PAGE_ROWS);
    const last = rows.at(-1);
    if (!last) return false;
    this.store.transaction(() => {
      const gen = this.store.meta().gen;
      for (const row of rows) this.store.applyVersion(row, gen, this.now());
      this.store.updateMeta((m) => {
        m.cursor = last.changeSeq;
      });
    });
    return rows.length === PAGE_ROWS;
  }

  /**
   * The full reconcile, a page per alarm: every playable version is applied (and its bot marked
   * seen); at the end, bots not seen stop. Starts every `reconcileMs`. Returns whether more pages
   * follow.
   */
  private async reconcile(c: MatchmakerConfig): Promise<boolean> {
    let meta = this.store.meta();
    if (!meta.sweep) {
      if (this.now() - meta.sweptAt < c.reconcileMs) return false;
      meta = this.store.updateMeta((m) => {
        m.gen++;
        m.sweep = { after: "" };
      });
    }
    const page = await playableVersions(this.env.DB, meta.sweep?.after ?? "", PAGE_ROWS);
    const last = page.at(-1);
    const full = page.length === PAGE_ROWS && last !== undefined;
    this.store.transaction(() => {
      const gen = this.store.meta().gen;
      for (const row of page) this.store.applyVersion(row, gen, this.now());
      if (full) {
        this.store.updateMeta((m) => {
          m.sweep = { after: last.botId };
        });
        return;
      }
      const stopped = this.store.disableUnseen(gen);
      if (stopped > 0) console.warn("matchmaker: reconcile stopped bots", stopped);
      this.store.updateMeta((m) => {
        m.sweep = null;
        m.sweptAt = this.now();
      });
    });
    return full;
  }

  /**
   * Asks rooms to retire lives that can't go on. A room that can't act on it yet (false: the
   * ticket hasn't reached it, or the batch in progress is spawning it), or a failed call, is
   * asked again with backoff until the life is reported (`lifeEnded`, `lifeDropped`) or lost.
   * Returns whether more are due now.
   */
  private async sendLeaves(): Promise<boolean> {
    const leaves = this.store.leaves(this.now(), LEAVES_PER_ALARM);
    let failed = 0;
    await Promise.all(
      leaves.map(async ({ lifeId, roomId, tries }) => {
        let left = false;
        try {
          left = await this.room(roomId).leave(lifeId);
        } catch (e) {
          failed++;
          console.error("matchmaker: leave failed", roomId, lifeId, e);
        }
        if (left) {
          this.store.leaveSent(lifeId);
          return;
        }
        const wait = Math.min(LEAVE_RETRY_MS * 2 ** tries, LEAVE_RETRY_MAX_MS);
        this.store.leaveLater(lifeId, this.now() + wait);
      }),
    );
    return leaves.length === LEAVES_PER_ALARM && failed === 0;
  }

  /**
   * Opens rooms for the lives waiting beyond `openThreshold` (and retries rooms whose `start`
   * failed). Returns whether more rooms may be needed right away.
   */
  private async openRooms(c: MatchmakerConfig): Promise<boolean> {
    const retries = this.store.rooms(["opening"]).slice(0, c.roomsPerAlarm);
    const wanted = () =>
      roomsToOpen(
        this.store.countWaiting(utcDay(this.now()), c.livesPerBotPerDay),
        this.store.rooms().length,
        c,
      );
    if (retries.length === 0 && wanted() === 0) return false;
    // The contract asks for a fresh read before starting a room; one that fails starts none.
    if (await this.readArenaControl(c, true, true)) return false;
    for (const r of retries) {
      if (await this.startRoom(r.roomId, c)) await this.fill(r.roomId, c);
    }
    const n = wanted();
    if (n === 0) return false;
    let opened = 0;
    for (; opened < n; opened++) {
      const roomId = crypto.randomUUID();
      this.store.setRoom(roomId, "opening", this.now());
      if (!(await this.startRoom(roomId, c))) break;
      if ((await this.fill(roomId, c)) === 0) break;
    }
    const waiting = this.store.countWaiting(utcDay(this.now()), c.livesPerBotPerDay);
    return opened === c.roomsPerAlarm && roomsToOpen(waiting, this.store.rooms().length, c) > 0;
  }

  private async startRoom(roomId: string, c: MatchmakerConfig): Promise<boolean> {
    try {
      await this.room(roomId).start({
        roomId,
        maxSnakes: c.maxSnakes,
        minAuthors: c.minAuthors,
        ...c.room,
      });
      this.store.setRoom(roomId, "open", this.now());
      console.log("matchmaker: room opened", roomId);
      return true;
    } catch (e) {
      console.error("matchmaker: room start failed", roomId, e);
      return false;
    }
  }

  /** Hands a room lives of distinct authors, front of the queue first. Returns how many joined. */
  private async fill(roomId: string, c: MatchmakerConfig): Promise<number> {
    const present = this.store.issuedIn(roomId).map((l) => l.author);
    const authors = new Set(present);
    const picks: QueuedBot[] = [];
    const day = utcDay(this.now());
    for (const bot of this.store.waiting(day, c.livesPerBotPerDay, present, c.maxSnakes * 4)) {
      if (present.length + picks.length >= c.maxSnakes) break;
      if (authors.has(bot.author)) continue;
      authors.add(bot.author);
      picks.push(bot);
    }
    let joined = 0;
    for (const ticket of await this.issue(roomId, picks)) {
      let result: JoinResult;
      try {
        result = await this.room(roomId).join(ticket);
      } catch (e) {
        // The room may have taken it: its report or the room check settles it.
        console.error("matchmaker: join failed", roomId, ticket.lifeId, e);
        continue;
      }
      if (result.ok) joined++;
      else {
        console.warn("matchmaker: room refused a life", roomId, ticket.lifeId, result.reason);
        this.store.dropLife(ticket.lifeId, this.now());
      }
    }
    return joined;
  }

  /**
   * Compares rooms' lives with the ledger, a few rooms per alarm: a life issued over
   * `lostAfterMs` ago that its room doesn't hold and nobody reported is lost. Also notices rooms
   * that stopped.
   */
  private async checkRooms(c: MatchmakerConfig): Promise<void> {
    const rooms = this.store.roomsToCheck(this.now() - c.roomCheckMs, ROOM_CHECKS_PER_ALARM);
    for (const r of rooms) {
      let s: RoomStatus;
      try {
        s = await this.room(r.roomId).status();
      } catch (e) {
        console.error("matchmaker: room status failed", r.roomId, e);
        continue;
      }
      const held = new Set([...s.snakes.map((x) => x.lifeId), ...s.pending]);
      const now = this.now();
      this.store.transaction(() => {
        this.store.roomChecked(r.roomId, now);
        const running = s.state === "running";
        if (running !== (r.state === "open")) {
          this.store.setRoom(r.roomId, running ? "open" : "closed", now);
        }
        for (const life of this.store.issuedIn(r.roomId)) {
          if (held.has(life.lifeId) || now - life.issuedAt < c.lostAfterMs) continue;
          console.warn("matchmaker: life lost", r.roomId, life.lifeId);
          this.store.loseLife(life.lifeId, now);
        }
      });
    }
  }

  // --- Helpers -----------------------------------------------------------------------------

  /**
   * Issues lives of `bots` to `roomId`: reserves each (counting it toward the quota), checks in
   * D1 that its version still plays, and loads its bundle. Bots that turn out not to play stop;
   * a reservation that fails is taken back. Throws (taking all back) only if D1 can't be read.
   */
  private async issue(roomId: string, bots: QueuedBot[]): Promise<LifeTicket[]> {
    const c = this.config();
    const now = this.now();
    const day = utcDay(now);
    const reserved = this.store.transaction(() =>
      bots
        .map((bot) => ({ bot, lifeId: crypto.randomUUID() }))
        .filter(({ bot, lifeId }) =>
          this.store.reserve(bot, roomId, lifeId, now, day, c.livesPerBotPerDay),
        ),
    );
    if (reserved.length === 0) return [];
    let current: Awaited<ReturnType<typeof versionsById>>;
    try {
      current = await versionsById(
        this.env.DB,
        reserved.map((r) => r.bot.versionId),
      );
    } catch (e) {
      this.store.transaction(() => {
        for (const r of reserved) this.store.unreserve(r.lifeId);
      });
      throw e;
    }
    const tickets = await Promise.all(
      reserved.map(async ({ bot, lifeId }): Promise<LifeTicket | null> => {
        const version = current.get(bot.versionId);
        if (!version?.playable) {
          this.store.transaction(() => {
            this.store.unreserve(lifeId);
            if (version) this.store.applyVersion(version, this.store.meta().gen, this.now());
            else this.store.disableVersion(bot.versionId);
          });
          return null;
        }
        let source: string | null;
        try {
          source = await this.source(bot.bundleKey);
        } catch (e) {
          console.error("matchmaker: bundle read failed", bot.bundleKey, e);
          this.store.unreserve(lifeId);
          return null;
        }
        if (source === null) {
          // A ready version without its bundle can't play; the next reconcile tries it again.
          console.error("matchmaker: bundle missing", bot.versionId, bot.bundleKey);
          this.store.transaction(() => {
            this.store.unreserve(lifeId);
            this.store.disableVersion(bot.versionId);
          });
          return null;
        }
        return { lifeId, versionId: bot.versionId, author: bot.author, source };
      }),
    );
    return tickets.filter((t) => t !== null);
  }

  /** A version's lives were evicted `evictions` times across rooms: quarantine it in D1. */
  private async quarantineEvicted(
    r: LifeResult,
    evictions: number,
    since: number,
    now: number,
  ): Promise<void> {
    const rooms = this.store.evictionRooms(r.versionId, since);
    const record: QuarantineRecord = {
      versionId: r.versionId,
      author: r.author,
      lifeId: r.lifeId,
      roomId: r.roomId,
      tick: r.endTick,
      evictions,
      kills: 0,
      message:
        "Quarantined by the arena for review: rooms' CPU backstop evicted " +
        `${evictions} of this bot's lives (in ${rooms.length} room${rooms.length === 1 ? "" : "s"}; ` +
        `last in room ${r.roomId} at tick ${r.endTick}). That's usually an operator on huge ` +
        "strings or objects, which the tick budget can't meter.",
      at: now,
    };
    // Throws on D1 errors: the room's outbox retries `lifeEnded`, which is idempotent.
    if ((await recordQuarantine(this.env.DB, record)) === "missing") {
      console.error("matchmaker: quarantine of a deleted version", r.versionId);
    }
    console.warn("matchmaker: version quarantined by evictions", r.versionId, evictions);
    this.store.disableVersion(r.versionId);
  }

  /**
   * The kill switch (`arena_control.paused`), re-read when older than `arenaControlPollMs` (or
   * `force`d). Stopping retires every life in flight; resuming reconciles from D1 as after a
   * restart. A failed read keeps the last answer, or says stopped if `failClosed`.
   */
  private async readArenaControl(
    c: MatchmakerConfig,
    force: boolean,
    failClosed = false,
  ): Promise<boolean> {
    const meta = this.store.meta();
    const now = this.now();
    if (!force && now - meta.pausedReadAt < c.arenaControlPollMs) return meta.paused;
    let paused: boolean;
    try {
      paused = await arenaPaused(this.env.DB);
    } catch (e) {
      console.error("matchmaker: arena control read failed", e);
      return failClosed || meta.paused;
    }
    this.store.transaction(() => {
      const was = this.store.meta().paused;
      this.store.updateMeta((m) => {
        m.paused = paused;
        m.pausedReadAt = now;
        if (was && !paused && m.cursor !== null) {
          m.gen++;
          m.sweep = { after: "" };
        }
      });
      if (paused && !was) this.store.retireAll();
    });
    if (paused !== meta.paused) console.warn("matchmaker: arena control", { paused });
    return paused;
  }

  private async source(key: string): Promise<string | null> {
    const hit = this.sources.get(key);
    if (hit !== undefined) {
      this.sources.delete(key);
      this.sources.set(key, hit);
      return hit;
    }
    const object = await this.env.BUNDLES.get(key);
    if (!object) return null;
    const text = await object.text();
    this.sources.set(key, text);
    for (const old of this.sources.keys()) {
      if (this.sources.size <= SOURCE_CACHE_SIZE) break;
      this.sources.delete(old);
    }
    return text;
  }

  /** Runs the alarm's work soon (not in manual mode: whoever drives `tick` does). */
  private async kick(): Promise<void> {
    if (!this.config().manual) await this.ctx.storage.setAlarm(Date.now());
  }

  private async ensureAlarm(): Promise<void> {
    if (this.config().manual) return;
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
  }

  private room(roomId: string): RoomRpc {
    return this.env.ROOMS.get(this.env.ROOMS.idFromName(roomId));
  }
}

export interface TickReport {
  /** Work was left over (more pages, leaves, rooms): the next alarm comes right away. */
  more: boolean;
}
