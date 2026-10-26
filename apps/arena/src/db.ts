/**
 * The arena's writes to D1. The schema belongs to apps/web (`src/db/schema.ts`, migrations in
 * `apps/web/migrations/`); the row types below mirror the columns used here.
 */
import type { DeathCause } from "@zerosnake/engine";
import type { BanRecord, LifeResult } from "./protocol.ts";

/** `lives` (apps/web `schema.ts`). Times are ms since the epoch. */
export interface LifeRow {
  id: string;
  version_id: string;
  room: string;
  start_tick: number;
  end_tick: number | null;
  score: number;
  length_max: number;
  kills: number;
  death_cause: DeathCause | null;
  killer: string | null;
  replay_key: string | null;
  trace_key: string | null;
  started_at: number;
  ended_at: number | null;
}

export function lifeRow(r: LifeResult): LifeRow {
  return {
    id: r.lifeId,
    version_id: r.versionId,
    room: r.roomId,
    start_tick: r.startTick,
    end_tick: r.endTick,
    score: Math.round(r.score),
    length_max: Math.round(r.lengthMax),
    kills: r.kills,
    death_cause: r.deathCause,
    killer: r.killer,
    replay_key: r.replayKey,
    trace_key: null,
    started_at: r.startedAt,
    ended_at: r.endedAt,
  };
}

/** Inserts finished lives. Idempotent: a life already written is left alone. */
export function insertLives(db: D1Database, results: LifeResult[]): Promise<D1Result[]> {
  return db.batch(
    results.map((r) => {
      const row = lifeRow(r);
      return db
        .prepare(
          `INSERT INTO lives (id, version_id, room, start_tick, end_tick, score, length_max, kills,
            death_cause, killer, replay_key, trace_key, started_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        )
        .bind(
          row.id,
          row.version_id,
          row.room,
          row.start_tick,
          row.end_tick,
          row.score,
          row.length_max,
          row.kills,
          row.death_cause,
          row.killer,
          row.replay_key,
          row.trace_key,
          row.started_at,
          row.ended_at,
        );
    }),
  );
}

/**
 * Records a backstop ban: the version leaves the arena for good. `versions.status` has no
 * `banned` value, so it becomes `rejected` with the ban as its report.
 */
export function recordBan(db: D1Database, ban: BanRecord): Promise<D1Result> {
  const report = JSON.stringify({ ban });
  return db
    .prepare(
      `UPDATE versions SET status = 'rejected', report = ?,
        updated_at = cast(unixepoch('subsecond') * 1000 as integer)
       WHERE id = ? AND status != 'rejected'`,
    )
    .bind(report, ban.versionId)
    .run();
}
