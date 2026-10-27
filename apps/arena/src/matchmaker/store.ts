/**
 * The matchmaker's Durable Object SQLite storage: the queue (one row per bot with a playable
 * version), the ledger of every life it issued, quota usage per bot and UTC day, the rooms it
 * opened, and evicted lives per version (with when each version last started playing, which
 * restarts its count).
 *
 * All methods are synchronous; writes made without an `await` in between commit together, so
 * each method is atomic with respect to the object's other requests.
 */
import type { LifeEndCause } from "../protocol.ts";
import type { MatchmakerConfig } from "./config.ts";
import type { VersionRow } from "./d1.ts";

/** A bot whose next life may be issued. */
export type QueuedBot = {
  botId: string;
  author: string;
  versionId: string;
  bundleKey: string;
};

/**
 * A life the matchmaker issued:
 * - `issued`: handed to a room, not reported back yet (the bot has no other life meanwhile);
 * - `ended`: `lifeEnded` (counts toward the quota);
 * - `dropped`: `lifeDropped` or a refused `join`: never ran, doesn't count;
 * - `lost`: no news long after its room stopped holding it (counts: it may have run).
 */
export type LifeState = "issued" | "ended" | "dropped" | "lost";

export type LedgerLife = {
  lifeId: string;
  botId: string;
  versionId: string;
  author: string;
  roomId: string;
  day: number;
  issuedAt: number;
  state: LifeState;
};

export type RoomState = "opening" | "open" | "closed";

export type RoomRow = {
  roomId: string;
  state: RoomState;
  openedAt: number;
  checkedAt: number;
};

/** Saved between alarms. */
export interface Meta {
  /** `versions.change_seq` of the last change applied; null before the first start. */
  cursor: number | null;
  /** Generation of the full reconcile: bots it saw get `seen_gen = gen`. */
  gen: number;
  /** The reconcile in progress (paged by bot id), or null. */
  sweep: { after: string } | null;
  /** Wall ms the last reconcile finished. */
  sweptAt: number;
  /** Next `queue_seq`: the back of the queue. */
  queueSeq: number;
  /** The kill switch as last read, and when (wall ms). */
  paused: boolean;
  pausedReadAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bots (bot_id TEXT PRIMARY KEY, author TEXT NOT NULL,
  version_id TEXT, bundle_key TEXT, queue_seq INTEGER NOT NULL, life_id TEXT,
  seen_gen INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS bots_queue_idx ON bots (queue_seq)
  WHERE version_id IS NOT NULL AND life_id IS NULL;
CREATE TABLE IF NOT EXISTS lives (life_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL,
  version_id TEXT NOT NULL, author TEXT NOT NULL, room_id TEXT NOT NULL, day INTEGER NOT NULL,
  issued_at INTEGER NOT NULL, state TEXT NOT NULL, cause TEXT, ended_at INTEGER,
  leave INTEGER NOT NULL DEFAULT 0, leave_at INTEGER NOT NULL DEFAULT 0,
  leave_tries INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS lives_issued_room_idx ON lives (room_id) WHERE state = 'issued';
CREATE INDEX IF NOT EXISTS lives_issued_version_idx ON lives (version_id) WHERE state = 'issued';
CREATE INDEX IF NOT EXISTS lives_day_idx ON lives (day);
CREATE TABLE IF NOT EXISTS usage (bot_id TEXT NOT NULL, day INTEGER NOT NULL,
  used INTEGER NOT NULL, PRIMARY KEY (bot_id, day));
CREATE TABLE IF NOT EXISTS rooms (room_id TEXT PRIMARY KEY, state TEXT NOT NULL,
  opened_at INTEGER NOT NULL, checked_at INTEGER NOT NULL DEFAULT 0, closed_at INTEGER);
CREATE TABLE IF NOT EXISTS evictions (life_id TEXT PRIMARY KEY, version_id TEXT NOT NULL,
  room_id TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS evictions_version_idx ON evictions (version_id);
CREATE INDEX IF NOT EXISTS evictions_at_idx ON evictions (at);
CREATE TABLE IF NOT EXISTS eviction_resets (version_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
`;

/**
 * `lives.leave`: none asked; to ask the room (`RoomRpc.leave`, again at `leave_at` while the room
 * can't act on it yet); the room took it.
 */
const LEAVE_NONE = 0;
const LEAVE_WANTED = 1;
const LEAVE_SENT = 2;

const DEFAULT_META: Meta = {
  cursor: null,
  gen: 0,
  sweep: null,
  sweptAt: 0,
  queueSeq: 1,
  paused: false,
  pausedReadAt: 0,
};

export class MatchmakerStore {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(SCHEMA);
  }

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }

  // --- Meta and config ---------------------------------------------------------------------

  private getJson<T>(key: string): T | null {
    const row = this.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)
      .next();
    return row.done ? null : (JSON.parse(row.value.value) as T);
  }

  private putJson(key: string, value: unknown): void {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(value),
    );
  }

  meta(): Meta {
    return { ...DEFAULT_META, ...this.getJson<Partial<Meta>>("meta") };
  }

  updateMeta(fn: (m: Meta) => void): Meta {
    const meta = this.meta();
    fn(meta);
    this.putJson("meta", meta);
    return meta;
  }

  configOverrides(): Partial<MatchmakerConfig> {
    return this.getJson<Partial<MatchmakerConfig>>("config") ?? {};
  }

  setConfigOverrides(c: Partial<MatchmakerConfig>): void {
    this.putJson("config", c);
  }

  /** Takes the back of the queue. */
  private nextQueueSeq(): number {
    let seq = 0;
    this.updateMeta((m) => {
      seq = m.queueSeq++;
    });
    return seq;
  }

  // --- Bots (the queue) --------------------------------------------------------------------

  /**
   * Applies a version's current state from D1. Playable: it becomes its bot's version (a bot new
   * to the queue joins at the back; a bot changing versions keeps its place, also when it had
   * none for a while, as between a deploy's archive of the old version and the new one's
   * activation), and its evictions count afresh (an admin lifted its quarantine, or it was
   * activated again). Not playable: its bot has no version any more, if this was it. Either way,
   * lives of versions that can't play any more are retired (`leave`). Returns whether the bot's
   * version changed.
   */
  applyVersion(v: VersionRow, gen: number, now: number): boolean {
    if (!v.playable) {
      this.retireVersion(v.versionId);
      return (
        this.sql.exec(
          "UPDATE bots SET version_id = NULL, bundle_key = NULL WHERE bot_id = ? AND version_id = ?",
          v.botId,
          v.versionId,
        ).rowsWritten > 0
      );
    }
    const bot = this.sql
      .exec<{ version_id: string | null }>("SELECT version_id FROM bots WHERE bot_id = ?", v.botId)
      .next();
    // Lives of the bot's other versions: replaced by this one.
    this.sql.exec(
      "UPDATE lives SET leave = ? WHERE bot_id = ? AND version_id != ? AND state = 'issued' AND leave = ?",
      LEAVE_WANTED,
      v.botId,
      v.versionId,
      LEAVE_NONE,
    );
    if (bot.done) {
      this.sql.exec(
        `INSERT INTO bots (bot_id, author, version_id, bundle_key, queue_seq, seen_gen)
         VALUES (?, ?, ?, ?, ?, ?)`,
        v.botId,
        v.author,
        v.versionId,
        v.bundleKey,
        this.nextQueueSeq(),
        gen,
      );
      return true;
    }
    const was = bot.value.version_id;
    this.sql.exec(
      "UPDATE bots SET author = ?, version_id = ?, bundle_key = ?, seen_gen = ? WHERE bot_id = ?",
      v.author,
      v.versionId,
      v.bundleKey,
      gen,
      v.botId,
    );
    if (was === v.versionId) return false;
    this.sql.exec(
      `INSERT INTO eviction_resets (version_id, at) VALUES (?1, ?2)
       ON CONFLICT(version_id) DO UPDATE SET at = ?2`,
      v.versionId,
      now,
    );
    return true;
  }

  /** The version can't play any more: its bot stops, and its lives in rooms are retired. */
  disableVersion(versionId: string): void {
    this.retireVersion(versionId);
    this.sql.exec(
      "UPDATE bots SET version_id = NULL, bundle_key = NULL WHERE version_id = ?",
      versionId,
    );
  }

  /** After a full reconcile: bots it didn't see (deleted, or not playable) stop. */
  disableUnseen(gen: number): number {
    const gone = this.sql
      .exec<{ version_id: string }>(
        "SELECT version_id FROM bots WHERE version_id IS NOT NULL AND seen_gen < ?",
        gen,
      )
      .toArray();
    for (const { version_id } of gone) this.disableVersion(version_id);
    return gone.length;
  }

  /**
   * Bots whose next life may be issued now, front of the queue first: a playable version, no
   * life in flight, quota left today, author not in `exclude`.
   */
  waiting(day: number, limitPerDay: number, exclude: string[], limit: number): QueuedBot[] {
    return this.sql
      .exec<QueuedBot>(
        `SELECT b.bot_id AS botId, b.author, b.version_id AS versionId, b.bundle_key AS bundleKey
         FROM bots b LEFT JOIN usage u ON u.bot_id = b.bot_id AND u.day = ?1
         WHERE b.version_id IS NOT NULL AND b.life_id IS NULL AND coalesce(u.used, 0) < ?2
           AND b.author NOT IN (SELECT value FROM json_each(?3))
         ORDER BY b.queue_seq LIMIT ?4`,
        day,
        limitPerDay,
        JSON.stringify(exclude),
        limit,
      )
      .toArray();
  }

  countWaiting(day: number, limitPerDay: number): number {
    return this.sql
      .exec<{ n: number }>(
        `SELECT count(*) AS n FROM bots b LEFT JOIN usage u ON u.bot_id = b.bot_id AND u.day = ?1
         WHERE b.version_id IS NOT NULL AND b.life_id IS NULL AND coalesce(u.used, 0) < ?2`,
        day,
        limitPerDay,
      )
      .one().n;
  }

  /** Bots with a playable version that used up `day`'s quota. */
  countExhausted(day: number, limitPerDay: number): number {
    return this.sql
      .exec<{ n: number }>(
        `SELECT count(*) AS n FROM bots b JOIN usage u ON u.bot_id = b.bot_id AND u.day = ?1
         WHERE b.version_id IS NOT NULL AND u.used >= ?2`,
        day,
        limitPerDay,
      )
      .one().n;
  }

  /** Whether `versionId` is its bot's version. */
  plays(versionId: string): boolean {
    return (
      this.sql.exec("SELECT 1 FROM bots WHERE version_id = ? LIMIT 1", versionId).toArray().length >
      0
    );
  }

  countPlayable(): number {
    return this.sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM bots WHERE version_id IS NOT NULL")
      .one().n;
  }

  // --- Lives (the ledger) ------------------------------------------------------------------

  /**
   * Issues `bot`'s next life to `roomId`, if it is still waiting with quota left: counts it
   * toward today's quota, and the bot has no other life until this one is reported back.
   */
  reserve(
    bot: QueuedBot,
    roomId: string,
    lifeId: string,
    now: number,
    day: number,
    limitPerDay: number,
  ): boolean {
    const still = this.sql
      .exec(
        `SELECT 1 FROM bots b LEFT JOIN usage u ON u.bot_id = b.bot_id AND u.day = ?2
         WHERE b.bot_id = ?1 AND b.version_id = ?3 AND b.life_id IS NULL
           AND coalesce(u.used, 0) < ?4`,
        bot.botId,
        day,
        bot.versionId,
        limitPerDay,
      )
      .toArray();
    if (still.length === 0) return false;
    this.sql.exec(
      `INSERT INTO lives (life_id, bot_id, version_id, author, room_id, day, issued_at, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'issued')`,
      lifeId,
      bot.botId,
      bot.versionId,
      bot.author,
      roomId,
      day,
      now,
    );
    this.sql.exec("UPDATE bots SET life_id = ? WHERE bot_id = ?", lifeId, bot.botId);
    this.addUsage(bot.botId, day, 1);
    return true;
  }

  /** Takes back a reservation that never reached a room: as if it never happened. */
  unreserve(lifeId: string): void {
    const life = this.life(lifeId);
    if (life?.state !== "issued") return;
    this.sql.exec("DELETE FROM lives WHERE life_id = ?", lifeId);
    this.sql.exec("UPDATE bots SET life_id = NULL WHERE life_id = ?", lifeId);
    this.addUsage(life.botId, life.day, -1);
  }

  life(lifeId: string): LedgerLife | null {
    const row = this.sql
      .exec<LedgerLife>(
        `SELECT life_id AS lifeId, bot_id AS botId, version_id AS versionId, author,
           room_id AS roomId, day, issued_at AS issuedAt, state FROM lives WHERE life_id = ?`,
        lifeId,
      )
      .next();
    return row.done ? null : row.value;
  }

  /**
   * The life ended. Idempotent: only the first report frees the bot, whose next life joins the
   * back of the queue. A life thought `dropped` counts toward the quota again.
   */
  endLife(lifeId: string, cause: LifeEndCause, now: number): LedgerLife | null {
    const life = this.life(lifeId);
    if (!life || life.state === "ended") return life;
    this.sql.exec(
      "UPDATE lives SET state = 'ended', cause = ?, ended_at = ? WHERE life_id = ?",
      cause,
      now,
      lifeId,
    );
    if (life.state === "dropped") this.addUsage(life.botId, life.day, 1);
    this.freeBot(lifeId, true);
    return life;
  }

  /**
   * The life never ran: the quota is given back, and the bot keeps its place in the queue.
   * Idempotent; a life already `ended` stays so.
   */
  dropLife(lifeId: string, now: number): LedgerLife | null {
    const life = this.life(lifeId);
    if (!life || life.state === "ended" || life.state === "dropped") return life;
    this.sql.exec(
      "UPDATE lives SET state = 'dropped', ended_at = ? WHERE life_id = ?",
      now,
      lifeId,
    );
    this.addUsage(life.botId, life.day, -1);
    this.freeBot(lifeId, false);
    return life;
  }

  /** Nobody reported the life and its room doesn't hold it: free the bot, keep the count. */
  loseLife(lifeId: string, now: number): void {
    const life = this.life(lifeId);
    if (life?.state !== "issued") return;
    this.sql.exec("UPDATE lives SET state = 'lost', ended_at = ? WHERE life_id = ?", now, lifeId);
    this.freeBot(lifeId, true);
  }

  private freeBot(lifeId: string, toBack: boolean): void {
    if (toBack) {
      const owner = this.sql.exec("SELECT 1 FROM bots WHERE life_id = ?", lifeId).toArray();
      if (owner.length === 0) return;
      this.sql.exec(
        "UPDATE bots SET life_id = NULL, queue_seq = ? WHERE life_id = ?",
        this.nextQueueSeq(),
        lifeId,
      );
    } else {
      this.sql.exec("UPDATE bots SET life_id = NULL WHERE life_id = ?", lifeId);
    }
  }

  private addUsage(botId: string, day: number, n: number): void {
    this.sql.exec(
      `INSERT INTO usage (bot_id, day, used) VALUES (?1, ?2, max(?3, 0))
       ON CONFLICT(bot_id, day) DO UPDATE SET used = max(used + ?3, 0)`,
      botId,
      day,
      n,
    );
  }

  /** Seeds a day's usage (lives counted elsewhere, e.g. D1's `lives` on the first start). */
  seedUsage(botId: string, day: number, used: number): void {
    this.sql.exec(
      `INSERT INTO usage (bot_id, day, used) VALUES (?, ?, ?)
       ON CONFLICT(bot_id, day) DO UPDATE SET used = max(used, excluded.used)`,
      botId,
      day,
      used,
    );
  }

  used(botId: string, day: number): number {
    const row = this.sql
      .exec<{ used: number }>("SELECT used FROM usage WHERE bot_id = ? AND day = ?", botId, day)
      .next();
    return row.done ? 0 : row.value.used;
  }

  /** Lives in flight in `roomId`. */
  issuedIn(roomId: string): LedgerLife[] {
    return this.sql
      .exec<LedgerLife>(
        `SELECT life_id AS lifeId, bot_id AS botId, version_id AS versionId, author,
           room_id AS roomId, day, issued_at AS issuedAt, state
         FROM lives WHERE room_id = ? AND state = 'issued'`,
        roomId,
      )
      .toArray();
  }

  countIssued(): number {
    return this.sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM lives WHERE state = 'issued'")
      .one().n;
  }

  // --- Retiring lives ----------------------------------------------------------------------

  private retireVersion(versionId: string): void {
    this.sql.exec(
      "UPDATE lives SET leave = ? WHERE version_id = ? AND state = 'issued' AND leave = ?",
      LEAVE_WANTED,
      versionId,
      LEAVE_NONE,
    );
  }

  /** The arena stopped: every life in flight is to be retired. */
  retireAll(): void {
    this.sql.exec(
      "UPDATE lives SET leave = ? WHERE state = 'issued' AND leave = ?",
      LEAVE_WANTED,
      LEAVE_NONE,
    );
  }

  /** Lives to ask their rooms to retire now. */
  leaves(now: number, limit: number): { lifeId: string; roomId: string; tries: number }[] {
    return this.sql
      .exec<{ lifeId: string; roomId: string; tries: number }>(
        `SELECT life_id AS lifeId, room_id AS roomId, leave_tries AS tries FROM lives
         WHERE state = 'issued' AND leave = ? AND leave_at <= ? LIMIT ?`,
        LEAVE_WANTED,
        now,
        limit,
      )
      .toArray();
  }

  leaveSent(lifeId: string): void {
    this.sql.exec("UPDATE lives SET leave = ? WHERE life_id = ?", LEAVE_SENT, lifeId);
  }

  /**
   * The room couldn't retire the life (yet): ask again at `at`, as long as it is in flight (a
   * ticket the room is still joining, or one its batch is spawning; once reported, it's settled).
   */
  leaveLater(lifeId: string, at: number): void {
    this.sql.exec(
      "UPDATE lives SET leave_at = ?, leave_tries = leave_tries + 1 WHERE life_id = ? AND leave = ?",
      at,
      lifeId,
      LEAVE_WANTED,
    );
  }

  // --- Evictions ---------------------------------------------------------------------------

  /**
   * Counts an evicted life that ended at `at` (once per life). Returns whether it was new, and
   * the version's evictions across rooms that count: since `since`, and since the version last
   * started playing (an admin lifting its quarantine starts the count afresh, so a late or
   * redelivered report of an older eviction doesn't put it straight back).
   */
  addEviction(
    lifeId: string,
    versionId: string,
    roomId: string,
    at: number,
    since: number,
  ): { added: boolean; count: number } {
    const added =
      this.sql.exec(
        `INSERT INTO evictions (life_id, version_id, room_id, at) VALUES (?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
        lifeId,
        versionId,
        roomId,
        at,
      ).rowsWritten > 0;
    return { added, count: this.evictionsSince(versionId, since).length };
  }

  /** Rooms where the version's lives were evicted, as `addEviction` counts them. */
  evictionRooms(versionId: string, since: number): string[] {
    return [...new Set(this.evictionsSince(versionId, since))].sort();
  }

  private evictionsSince(versionId: string, since: number): string[] {
    return this.sql
      .exec<{ room_id: string }>(
        `SELECT room_id FROM evictions WHERE version_id = ?1 AND at >= max(?2,
           coalesce((SELECT at FROM eviction_resets WHERE version_id = ?1), 0))`,
        versionId,
        since,
      )
      .toArray()
      .map((r) => r.room_id);
  }

  // --- Rooms -------------------------------------------------------------------------------

  rooms(states: RoomState[] = ["opening", "open"]): RoomRow[] {
    return this.sql
      .exec<RoomRow>(
        `SELECT room_id AS roomId, state, opened_at AS openedAt, checked_at AS checkedAt
         FROM rooms WHERE state IN (SELECT value FROM json_each(?)) ORDER BY opened_at, room_id`,
        JSON.stringify(states),
      )
      .toArray();
  }

  room(roomId: string): RoomRow | null {
    const row = this.sql
      .exec<RoomRow>(
        `SELECT room_id AS roomId, state, opened_at AS openedAt, checked_at AS checkedAt
         FROM rooms WHERE room_id = ?`,
        roomId,
      )
      .next();
    return row.done ? null : row.value;
  }

  setRoom(roomId: string, state: RoomState, now: number): void {
    this.sql.exec(
      `INSERT INTO rooms (room_id, state, opened_at, closed_at) VALUES (?1, ?2, ?3,
         CASE WHEN ?2 = 'closed' THEN ?3 END)
       ON CONFLICT(room_id) DO UPDATE SET state = ?2,
         closed_at = CASE WHEN ?2 = 'closed' THEN ?3 END`,
      roomId,
      state,
      now,
    );
  }

  /**
   * Rooms not checked since `before`, least recently checked first: open ones, and closed ones
   * with lives still in flight (reports can come after `roomClosed`).
   */
  roomsToCheck(before: number, limit: number): RoomRow[] {
    return this.sql
      .exec<RoomRow>(
        `SELECT room_id AS roomId, state, opened_at AS openedAt, checked_at AS checkedAt
         FROM rooms r WHERE checked_at < ? AND (state = 'open' OR EXISTS
           (SELECT 1 FROM lives l WHERE l.room_id = r.room_id AND l.state = 'issued'))
         ORDER BY checked_at LIMIT ?`,
        before,
        limit,
      )
      .toArray();
  }

  roomChecked(roomId: string, now: number): void {
    this.sql.exec("UPDATE rooms SET checked_at = ? WHERE room_id = ?", now, roomId);
  }

  // --- Housekeeping ------------------------------------------------------------------------

  /**
   * Forgets settled lives and usage from before yesterday, rooms closed over a day ago with
   * nothing in flight, and evictions (and count restarts) from before `evictionsSince`. Returns
   * the rows deleted (at most about `limit` per table).
   */
  prune(day: number, now: number, evictionsSince: number, limit: number): number {
    let n = 0;
    n += this.sql.exec(
      `DELETE FROM lives WHERE life_id IN (SELECT life_id FROM lives
         WHERE day < ? AND state != 'issued' LIMIT ?)`,
      day - 1,
      limit,
    ).rowsWritten;
    n += this.sql.exec(
      `DELETE FROM usage WHERE rowid IN (SELECT rowid FROM usage WHERE day < ? LIMIT ?)`,
      day - 1,
      limit,
    ).rowsWritten;
    n += this.sql.exec(
      `DELETE FROM rooms WHERE room_id IN (SELECT room_id FROM rooms r WHERE state = 'closed'
         AND closed_at < ? AND NOT EXISTS
           (SELECT 1 FROM lives l WHERE l.room_id = r.room_id AND l.state = 'issued') LIMIT ?)`,
      now - 86_400_000,
      limit,
    ).rowsWritten;
    n += this.sql.exec(
      "DELETE FROM evictions WHERE life_id IN (SELECT life_id FROM evictions WHERE at < ? LIMIT ?)",
      evictionsSince,
      limit,
    ).rowsWritten;
    n += this.sql.exec(
      `DELETE FROM eviction_resets WHERE version_id IN
         (SELECT version_id FROM eviction_resets WHERE at < ? LIMIT ?)`,
      evictionsSince,
      limit,
    ).rowsWritten;
    return n;
  }
}
