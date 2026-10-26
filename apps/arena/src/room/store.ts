/**
 * The room's Durable Object SQLite storage: everything needed to resume after an eviction or a
 * batch that died (world snapshot, open replay chunk, roster, pending tickets, outbox of side
 * effects, the in-progress batch marker, bans).
 *
 * All methods are synchronous; writes made without an `await` in between commit together.
 */
import type { RoomMode } from "../protocol.ts";

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
  replayKey: string;
  /** Retire at the next batch (`RoomRpc.leave`). */
  leaving: boolean;
}

export interface PendingEntry extends LifeEntry {
  seq: number;
}

/** Written before a batch runs and deleted in the same transaction that saves its result. */
export interface BatchMarker {
  fromTick: number;
  ticks: number;
  /** Pending tickets with `seq` up to this one spawn in the batch. */
  maxPendingSeq: number;
  /** The batch is being replayed by the backstop, one bot at a time. */
  isolate: boolean;
  /** In an isolated replay: the life whose code was running (null between bots). */
  suspectLife: string | null;
  suspectTick: number | null;
}

export interface Meta {
  roomId: string;
  state: "running" | "closed";
  mode: RoomMode;
  maxSnakes: number;
  minAuthors: number;
  manual: boolean;
  livesEnded: number;
  lastBatchTicks: number;
  /** Don't ask the matchmaker for lives before this wall-clock ms (it had none). */
  nextLifeAfter: number;
  /** Real-time mode: wall-clock ms the next batch is due. */
  realtimeNext: number;
}

export type OutboxItem =
  | { kind: "chunk"; key: string; bytes: Uint8Array }
  | { kind: "life"; json: string }
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
  outcome: "banned" | "inconclusive";
  versionId: string | null;
}

/** SQLite caps a value at 2 MB; blobs are split into parts below that. */
const BLOB_PART_BYTES = 1 << 20;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blobs (key TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL,
  PRIMARY KEY (key, part));
CREATE TABLE IF NOT EXISTS roster (life_id TEXT PRIMARY KEY, version_id TEXT, author TEXT NOT NULL,
  house TEXT, source TEXT NOT NULL, start_tick INTEGER NOT NULL, started_at INTEGER NOT NULL,
  replay_key TEXT NOT NULL, leaving INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS pending (seq INTEGER PRIMARY KEY AUTOINCREMENT,
  life_id TEXT NOT NULL UNIQUE, version_id TEXT, author TEXT NOT NULL, house TEXT,
  source TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
  key TEXT, body BLOB, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS batch (id INTEGER PRIMARY KEY CHECK (id = 1), from_tick INTEGER NOT NULL,
  ticks INTEGER NOT NULL, max_pending_seq INTEGER NOT NULL, isolate INTEGER NOT NULL,
  suspect_life TEXT, suspect_tick INTEGER);
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
        replay_key: string;
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
        replayKey: r.replay_key,
        leaving: r.leaving !== 0,
      }));
  }

  addToRoster(e: RosterEntry): void {
    this.sql.exec(
      `INSERT INTO roster (life_id, version_id, author, house, source, start_tick, started_at,
        replay_key, leaving) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.lifeId,
      e.versionId,
      e.author,
      e.house,
      e.source,
      e.startTick,
      e.startedAt,
      e.replayKey,
      e.leaving ? 1 : 0,
    );
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
          "INSERT INTO outbox (kind, key, body) VALUES ('chunk', ?, ?)",
          item.key,
          toBuffer(item.bytes),
        );
        break;
      case "life":
      case "ban":
        this.sql.exec(
          "INSERT INTO outbox (kind, body) VALUES (?, ?)",
          item.kind,
          toBuffer(encoder.encode(item.json)),
        );
        break;
      case "closed":
        this.sql.exec("INSERT INTO outbox (kind) VALUES ('closed')");
        break;
    }
  }

  outbox(): { seq: number; item: OutboxItem }[] {
    return this.sql
      .exec<{ seq: number; kind: string; key: string | null; body: ArrayBuffer | null }>(
        "SELECT seq, kind, key, body FROM outbox ORDER BY seq",
      )
      .toArray()
      .map((r) => {
        const body = r.body ? new Uint8Array(r.body) : new Uint8Array();
        let item: OutboxItem;
        if (r.kind === "chunk") item = { kind: "chunk", key: r.key ?? "", bytes: body };
        else if (r.kind === "life" || r.kind === "ban") {
          item = { kind: r.kind, json: decoder.decode(body) };
        } else item = { kind: "closed" };
        return { seq: r.seq, item };
      });
  }

  done(seq: number): void {
    this.sql.exec("DELETE FROM outbox WHERE seq = ?", seq);
  }

  /** Counts a failed attempt; returns how many there have been. */
  failed(seq: number): number {
    return this.sql
      .exec<{ attempts: number }>(
        "UPDATE outbox SET attempts = attempts + 1 WHERE seq = ? RETURNING attempts",
        seq,
      )
      .one().attempts;
  }

  // --- Batch marker ------------------------------------------------------------------------

  marker(): BatchMarker | null {
    const row = this.sql
      .exec<{
        from_tick: number;
        ticks: number;
        max_pending_seq: number;
        isolate: number;
        suspect_life: string | null;
        suspect_tick: number | null;
      }>("SELECT * FROM batch WHERE id = 1")
      .next();
    if (row.done) return null;
    const r = row.value;
    return {
      fromTick: r.from_tick,
      ticks: r.ticks,
      maxPendingSeq: r.max_pending_seq,
      isolate: r.isolate !== 0,
      suspectLife: r.suspect_life,
      suspectTick: r.suspect_tick,
    };
  }

  setMarker(m: BatchMarker): void {
    this.sql.exec(
      `INSERT INTO batch (id, from_tick, ticks, max_pending_seq, isolate, suspect_life, suspect_tick)
       VALUES (1, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET from_tick = excluded.from_tick,
       ticks = excluded.ticks, max_pending_seq = excluded.max_pending_seq,
       isolate = excluded.isolate, suspect_life = excluded.suspect_life,
       suspect_tick = excluded.suspect_tick`,
      m.fromTick,
      m.ticks,
      m.maxPendingSeq,
      m.isolate ? 1 : 0,
      m.suspectLife,
      m.suspectTick,
    );
  }

  setSuspect(lifeId: string | null, tick: number | null): void {
    this.sql.exec("UPDATE batch SET suspect_life = ?, suspect_tick = ? WHERE id = 1", lifeId, tick);
  }

  clearMarker(): void {
    this.sql.exec("DELETE FROM batch");
  }

  // --- Bans and incidents ------------------------------------------------------------------

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
      .exec<{ tick: number; outcome: string; version_id: string | null }>(
        "SELECT tick, outcome, version_id FROM incidents ORDER BY seq",
      )
      .toArray()
      .map((r) => ({
        tick: r.tick,
        outcome: r.outcome as IncidentRow["outcome"],
        versionId: r.version_id,
      }));
  }

  addIncident(i: IncidentRow, at: number): void {
    this.sql.exec(
      "INSERT INTO incidents (tick, outcome, version_id, at) VALUES (?, ?, ?, ?)",
      i.tick,
      i.outcome,
      i.versionId,
      at,
    );
  }
}
