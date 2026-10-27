/**
 * The room's Durable Object SQLite storage: everything needed to resume after an eviction or a
 * batch that died (world snapshot, open replay chunk, roster, pending tickets, outbox of side
 * effects, the in-progress batch marker, strikes, bans, incidents).
 *
 * All methods are synchronous; writes made without an `await` in between commit together.
 */
import type { IncidentOutcome, RoomLimits, RoomMode } from "../protocol.ts";
import type { CrashMarker, Trial, WatchWindow } from "./backstop.ts";

/** A life the room holds: spawned (`roster`) or waiting for the next batch (`pending`). */
export interface LifeEntry {
  lifeId: string;
  /** Null for house bots. */
  versionId: string | null;
  author: string;
  /** House bot kind, null for deployed versions. */
  house: string | null;
  /** Bundle source; empty for house bots (their bundles ship with the worker). */
  source: string;
}

export interface RosterEntry extends LifeEntry {
  startTick: number;
  startedAt: number;
  /** Tick its current sandbox life began: the spawn, or the reload that last restarted the bot. */
  botStartTick: number;
  /** Retire at the next batch (`RoomRpc.leave`). */
  leaving: boolean;
}

export interface PendingEntry extends LifeEntry {
  seq: number;
}

/** Written (and synced) before a batch runs; deleted in the transaction that saves its result. */
export interface BatchMarker extends CrashMarker {
  /** A batch of the room, or a trial of one suspect (see `backstop.ts`). */
  phase: "batch" | "trial";
  fromTick: number;
  /** Pending tickets with `seq` up to this one spawn in the batch. */
  maxPendingSeq: number;
  suspectTick: number | null;
  /**
   * Trial: the suspect's call in progress, `init@<tick>` or `tick@<tick>`; null between calls.
   */
  trialCall: string | null;
}

export interface Meta {
  roomId: string;
  state: "running" | "closed";
  mode: RoomMode;
  maxSnakes: number;
  minAuthors: number;
  manual: boolean;
  limits: Required<RoomLimits>;
  livesEnded: number;
  lastBatchTicks: number;
  /** Don't ask the matchmaker for lives before this wall-clock ms (it had none). */
  nextLifeAfter: number;
  /** Real-time mode: wall-clock ms the next batch is due. */
  realtimeNext: number;
  /** Watch mode (see `backstop.ts`) runs while either bound is ahead. */
  watch: WatchWindow;
  /** Start tick of the replay chunk still being recorded (not in R2 yet), or null. */
  openChunkTick: number | null;
  /** A suspect waiting for (or in) its trial; no batch runs meanwhile. */
  trial: Trial | null;
}

export type OutboxItem =
  | { kind: "chunk"; key: string; tick: number; bytes: Uint8Array }
  /** `chunkTick`: the replay chunk the life's row points to; sent only once it is in R2. */
  | { kind: "life"; json: string; chunkTick: number }
  | { kind: "ban"; json: string }
  | { kind: "closed" };

export interface BanRow {
  versionId: string;
  lifeId: string;
  tick: number;
  at: number;
}

export interface IncidentRow {
  tick: number;
  outcome: IncidentOutcome;
  versionId: string | null;
  at: number;
}

export interface StrikeRow {
  versionId: string;
  lifeId: string;
  kind: "cpu" | "slow";
  tick: number;
  detail: string;
  at: number;
}

/** SQLite caps a value at 2 MB; blobs are split into parts below that. */
const BLOB_PART_BYTES = 1 << 20;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blobs (key TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL,
  PRIMARY KEY (key, part));
CREATE TABLE IF NOT EXISTS roster (life_id TEXT PRIMARY KEY, version_id TEXT, author TEXT NOT NULL,
  house TEXT, source TEXT NOT NULL, start_tick INTEGER NOT NULL, started_at INTEGER NOT NULL,
  bot_start_tick INTEGER NOT NULL, leaving INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS pending (seq INTEGER PRIMARY KEY AUTOINCREMENT,
  life_id TEXT NOT NULL UNIQUE, version_id TEXT, author TEXT NOT NULL, house TEXT,
  source TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
  key TEXT, tick INTEGER, body BLOB, attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0, last_error TEXT);
CREATE TABLE IF NOT EXISTS batch (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS strikes (seq INTEGER PRIMARY KEY AUTOINCREMENT, version_id TEXT NOT NULL,
  life_id TEXT NOT NULL, kind TEXT NOT NULL, tick INTEGER NOT NULL, detail TEXT NOT NULL,
  at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bans (version_id TEXT PRIMARY KEY, life_id TEXT NOT NULL,
  tick INTEGER NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS incidents (seq INTEGER PRIMARY KEY AUTOINCREMENT, tick INTEGER NOT NULL,
  outcome TEXT NOT NULL, version_id TEXT, at INTEGER NOT NULL);
`;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

export class RoomStore {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(SCHEMA);
  }

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }

  // --- Meta --------------------------------------------------------------------------------

  meta(): Meta | null {
    const row = this.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'room'")
      .next();
    return row.done ? null : (JSON.parse(row.value.value) as Meta);
  }

  setMeta(meta: Meta): void {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('room', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify(meta),
    );
  }

  /** Reads, changes and writes the meta row. */
  updateMeta(fn: (meta: Meta) => void): Meta | null {
    const meta = this.meta();
    if (!meta) return null;
    fn(meta);
    this.setMeta(meta);
    return meta;
  }

  // --- Blobs -------------------------------------------------------------------------------

  putBlob(key: string, bytes: Uint8Array | null): void {
    this.sql.exec("DELETE FROM blobs WHERE key = ?", key);
    if (!bytes) return;
    for (let part = 0, at = 0; at === 0 || at < bytes.length; part++, at += BLOB_PART_BYTES) {
      const data = toBuffer(bytes.subarray(at, at + BLOB_PART_BYTES));
      this.sql.exec("INSERT INTO blobs (key, part, data) VALUES (?, ?, ?)", key, part, data);
    }
  }

  getBlob(key: string): Uint8Array | null {
    const parts = this.sql
      .exec<{ data: ArrayBuffer }>("SELECT data FROM blobs WHERE key = ? ORDER BY part", key)
      .toArray()
      .map((r) => new Uint8Array(r.data));
    if (parts.length === 0) return null;
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  putJson(key: string, value: unknown): void {
    this.putBlob(key, encoder.encode(JSON.stringify(value)));
  }

  getJson<T>(key: string): T | null {
    const bytes = this.getBlob(key);
    return bytes ? (JSON.parse(decoder.decode(bytes)) as T) : null;
  }

  // --- Roster and pending tickets ----------------------------------------------------------

  roster(): RosterEntry[] {
    return this.sql
      .exec<{
        life_id: string;
        version_id: string | null;
        author: string;
        house: string | null;
        source: string;
        start_tick: number;
        started_at: number;
        bot_start_tick: number;
        leaving: number;
      }>("SELECT * FROM roster ORDER BY start_tick, life_id")
      .toArray()
      .map((r) => ({
        lifeId: r.life_id,
        versionId: r.version_id,
        author: r.author,
        house: r.house,
        source: r.source,
        startTick: r.start_tick,
        startedAt: r.started_at,
        botStartTick: r.bot_start_tick,
        leaving: r.leaving !== 0,
      }));
  }

  addToRoster(e: RosterEntry): void {
    this.sql.exec(
      `INSERT INTO roster (life_id, version_id, author, house, source, start_tick, started_at,
        bot_start_tick, leaving) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.lifeId,
      e.versionId,
      e.author,
      e.house,
      e.source,
      e.startTick,
      e.startedAt,
      e.botStartTick,
      e.leaving ? 1 : 0,
    );
  }

  setBotStart(lifeIds: readonly string[], tick: number): void {
    for (const id of lifeIds) {
      this.sql.exec("UPDATE roster SET bot_start_tick = ? WHERE life_id = ?", tick, id);
    }
  }

  removeFromRoster(lifeId: string): void {
    this.sql.exec("DELETE FROM roster WHERE life_id = ?", lifeId);
  }

  markLeaving(lifeId: string): boolean {
    return this.sql.exec("UPDATE roster SET leaving = 1 WHERE life_id = ?", lifeId).rowsWritten > 0;
  }

  pending(maxSeq = Number.MAX_SAFE_INTEGER): PendingEntry[] {
    return this.sql
      .exec<{
        seq: number;
        life_id: string;
        version_id: string | null;
        author: string;
        house: string | null;
        source: string;
      }>("SELECT * FROM pending WHERE seq <= ? ORDER BY seq", maxSeq)
      .toArray()
      .map((r) => ({
        seq: r.seq,
        lifeId: r.life_id,
        versionId: r.version_id,
        author: r.author,
        house: r.house,
        source: r.source,
      }));
  }

  addPending(e: LifeEntry): void {
    this.sql.exec(
      "INSERT INTO pending (life_id, version_id, author, house, source) VALUES (?, ?, ?, ?, ?)",
      e.lifeId,
      e.versionId,
      e.author,
      e.house,
      e.source,
    );
  }

  /** The newest pending ticket's `seq` (0 if none). */
  lastPendingSeq(): number {
    return this.sql.exec<{ m: number | null }>("SELECT max(seq) AS m FROM pending").one().m ?? 0;
  }

  removePendingLife(lifeId: string): boolean {
    return this.sql.exec("DELETE FROM pending WHERE life_id = ?", lifeId).rowsWritten > 0;
  }

  removePending(maxSeq: number): void {
    this.sql.exec("DELETE FROM pending WHERE seq <= ?", maxSeq);
  }

  // --- Outbox ------------------------------------------------------------------------------

  enqueue(item: OutboxItem): void {
    switch (item.kind) {
      case "chunk":
        this.sql.exec(
          "INSERT INTO outbox (kind, key, tick, body) VALUES ('chunk', ?, ?, ?)",
          item.key,
          item.tick,
          toBuffer(item.bytes),
        );
        break;
      case "life":
        this.sql.exec(
          "INSERT INTO outbox (kind, tick, body) VALUES ('life', ?, ?)",
          item.chunkTick,
          toBuffer(encoder.encode(item.json)),
        );
        break;
      case "ban":
        this.sql.exec(
          "INSERT INTO outbox (kind, body) VALUES ('ban', ?)",
          toBuffer(encoder.encode(item.json)),
        );
        break;
      case "closed":
        this.sql.exec("INSERT INTO outbox (kind) VALUES ('closed')");
        break;
    }
  }

  /**
   * Items due by `now`, oldest first. A life waits until its replay chunk is in R2: closed
   * (`openChunkTick` is past it, or no chunk is open) and no longer in the outbox.
   */
  dueOutbox(now: number, openChunkTick: number | null): { seq: number; item: OutboxItem }[] {
    return this.sql
      .exec<{
        seq: number;
        kind: string;
        key: string | null;
        tick: number | null;
        body: ArrayBuffer | null;
      }>(
        `SELECT seq, kind, key, tick, body FROM outbox o WHERE next_at <= ?1 AND (kind != 'life' OR
           ((?2 IS NULL OR tick < ?2) AND NOT EXISTS
             (SELECT 1 FROM outbox c WHERE c.kind = 'chunk' AND c.tick = o.tick)))
         ORDER BY seq`,
        now,
        openChunkTick,
      )
      .toArray()
      .map((r) => {
        const body = r.body ? new Uint8Array(r.body) : new Uint8Array();
        let item: OutboxItem;
        if (r.kind === "chunk") {
          item = { kind: "chunk", key: r.key ?? "", tick: r.tick ?? 0, bytes: body };
        } else if (r.kind === "life") {
          item = { kind: "life", json: decoder.decode(body), chunkTick: r.tick ?? 0 };
        } else if (r.kind === "ban") item = { kind: "ban", json: decoder.decode(body) };
        else item = { kind: "closed" };
        return { seq: r.seq, item };
      });
  }

  /** A replay chunk still waiting for its R2 upload. */
  outboxChunk(tick: number): Uint8Array | null {
    const row = this.sql
      .exec<{ body: ArrayBuffer }>(
        "SELECT body FROM outbox WHERE kind = 'chunk' AND tick = ? LIMIT 1",
        tick,
      )
      .next();
    return row.done ? null : new Uint8Array(row.value.body);
  }

  outboxStats(): { size: number; failing: number; nextAt: number | null } {
    const r = this.sql
      .exec<{ size: number; failing: number; next_at: number | null }>(
        `SELECT count(*) AS size, sum(attempts > 0) AS failing,
           min(CASE WHEN attempts > 0 THEN next_at END) AS next_at FROM outbox`,
      )
      .one();
    return { size: r.size, failing: r.failing ?? 0, nextAt: r.next_at };
  }

  done(seq: number): void {
    this.sql.exec("DELETE FROM outbox WHERE seq = ?", seq);
  }

  /** Counts a failed attempt and sets when to retry; returns the attempts so far. */
  failed(seq: number, nextAt: (attempts: number) => number, error: string): number {
    const attempts = this.sql
      .exec<{ attempts: number }>(
        "UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE seq = ? RETURNING attempts",
        error.slice(0, 500),
        seq,
      )
      .one().attempts;
    this.sql.exec("UPDATE outbox SET next_at = ? WHERE seq = ?", nextAt(attempts), seq);
    return attempts;
  }

  // --- Batch marker ------------------------------------------------------------------------

  marker(): BatchMarker | null {
    const row = this.sql.exec<{ json: string }>("SELECT json FROM batch WHERE id = 1").next();
    return row.done ? null : (JSON.parse(row.value.json) as BatchMarker);
  }

  setMarker(m: BatchMarker): void {
    this.sql.exec(
      "INSERT INTO batch (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
      JSON.stringify(m),
    );
  }

  clearMarker(): void {
    this.sql.exec("DELETE FROM batch");
  }

  // --- Strikes, bans and incidents ---------------------------------------------------------

  addStrike(s: StrikeRow): number {
    this.sql.exec(
      "INSERT INTO strikes (version_id, life_id, kind, tick, detail, at) VALUES (?, ?, ?, ?, ?, ?)",
      s.versionId,
      s.lifeId,
      s.kind,
      s.tick,
      s.detail,
      s.at,
    );
    return this.sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM strikes WHERE version_id = ?", s.versionId)
      .one().n;
  }

  isStruck(lifeId: string): boolean {
    return !this.sql.exec("SELECT 1 FROM strikes WHERE life_id = ?", lifeId).next().done;
  }

  strikes(): StrikeRow[] {
    return this.sql
      .exec<{
        version_id: string;
        life_id: string;
        kind: string;
        tick: number;
        detail: string;
        at: number;
      }>("SELECT * FROM strikes ORDER BY seq")
      .toArray()
      .map((r) => ({
        versionId: r.version_id,
        lifeId: r.life_id,
        kind: r.kind as StrikeRow["kind"],
        tick: r.tick,
        detail: r.detail,
        at: r.at,
      }));
  }

  bans(): BanRow[] {
    return this.sql
      .exec<{ version_id: string; life_id: string; tick: number; at: number }>(
        "SELECT * FROM bans ORDER BY at",
      )
      .toArray()
      .map((r) => ({ versionId: r.version_id, lifeId: r.life_id, tick: r.tick, at: r.at }));
  }

  isBanned(versionId: string): boolean {
    return !this.sql.exec("SELECT 1 FROM bans WHERE version_id = ?", versionId).next().done;
  }

  addBan(b: BanRow): void {
    this.sql.exec(
      "INSERT OR IGNORE INTO bans (version_id, life_id, tick, at) VALUES (?, ?, ?, ?)",
      b.versionId,
      b.lifeId,
      b.tick,
      b.at,
    );
  }

  incidents(): IncidentRow[] {
    return this.sql
      .exec<{ tick: number; outcome: string; version_id: string | null; at: number }>(
        "SELECT tick, outcome, version_id, at FROM incidents ORDER BY seq",
      )
      .toArray()
      .map((r) => ({
        tick: r.tick,
        outcome: r.outcome as IncidentOutcome,
        versionId: r.version_id,
        at: r.at,
      }));
  }

  addIncident(i: IncidentRow): void {
    this.sql.exec(
      "INSERT INTO incidents (tick, outcome, version_id, at) VALUES (?, ?, ?, ?)",
      i.tick,
      i.outcome,
      i.versionId,
      i.at,
    );
  }

  /** Batches that died with CPU-limit evidence (`overrun`, `suspect`) since `since`. */
  cpuIncidentsSince(since: number): number {
    return this.sql
      .exec<{ n: number }>(
        "SELECT count(*) AS n FROM incidents WHERE outcome IN ('overrun', 'suspect') AND at >= ?",
        since,
      )
      .one().n;
  }
}
