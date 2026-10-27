/**
 * The running lives' traces (`trace.ts`) in the room's SQLite: one row per head, load log and
 * kept tick, so a batch writes only what changed (`TraceRecorder.changes`), not every recorder's
 * whole state. Writes made in a `RoomStore.transaction` commit with it.
 */
import { utf8Bytes } from "@zerosnake/web/shared";
import { type TraceChange, TraceRecorder, type TraceRow, type TraceRowKind } from "./trace.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trace_rows (life_id TEXT NOT NULL, kind TEXT NOT NULL,
  tick INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (life_id, kind, tick));
`;

/** The part of `SqlStorage` this uses (tests pass node:sqlite). */
export interface TraceSql {
  exec<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: unknown[]
  ): { toArray(): T[] };
}

export class TraceStore {
  constructor(private readonly sql: TraceSql) {
    sql.exec(SCHEMA);
  }

  /** Saves a life's changed rows; returns the bytes of JSON written. */
  save(lifeId: string, changes: readonly TraceChange[]): number {
    let bytes = 0;
    for (const c of changes) {
      if (c.json === null) {
        this.sql.exec(
          "DELETE FROM trace_rows WHERE life_id = ? AND kind = ? AND tick = ?",
          lifeId,
          c.kind,
          c.tick,
        );
        continue;
      }
      this.sql.exec(
        "INSERT OR REPLACE INTO trace_rows (life_id, kind, tick, json) VALUES (?, ?, ?, ?)",
        lifeId,
        c.kind,
        c.tick,
        c.json,
      );
      bytes += utf8Bytes(c.json);
    }
    return bytes;
  }

  /** Every saved life's recorder. */
  load(): Record<string, TraceRecorder> {
    const rows = this.sql
      .exec<{ life_id: string; kind: string; tick: number; json: string }>(
        "SELECT life_id, kind, tick, json FROM trace_rows ORDER BY life_id, kind, tick",
      )
      .toArray();
    const byLife = new Map<string, TraceRow[]>();
    for (const r of rows) {
      const list = byLife.get(r.life_id) ?? [];
      byLife.set(r.life_id, list);
      list.push({ kind: r.kind as TraceRowKind, tick: r.tick, json: r.json });
    }
    const out: Record<string, TraceRecorder> = {};
    for (const [lifeId, list] of byLife) {
      const recorder = TraceRecorder.fromRows(list);
      if (recorder) out[lifeId] = recorder;
    }
    return out;
  }

  delete(lifeId: string): void {
    this.sql.exec("DELETE FROM trace_rows WHERE life_id = ?", lifeId);
  }

  clear(): void {
    this.sql.exec("DELETE FROM trace_rows");
  }
}
