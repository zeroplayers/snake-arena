/**
 * The arena's writes to D1. The schema belongs to apps/web (`src/db/schema.ts`, migrations in
 * `apps/web/migrations/`); the row types below mirror the columns used here.
 */
import type { DeathCause } from "@zerosnake/engine";
import type { LifeResult, QuarantineRecord } from "./protocol.ts";

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

/** The row for a finished life, or null for an `evicted` one (not a `lives.death_cause` yet). */
export function lifeRow(r: LifeResult): LifeRow | null {
  if (r.deathCause === "evicted") return null;
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

/**
 * Inserts finished lives. Idempotent: a life already written is left alone. `evicted` lives are
 * skipped: `lives.death_cause` doesn't allow the value, and they mustn't count toward ratings.
 */
export async function insertLives(db: D1Database, results: LifeResult[]): Promise<void> {
  const rows = results.map(lifeRow).filter((row) => row !== null);
  if (rows.length === 0) return;
  await db.batch(
    rows.map((row) =>
      db
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
        ),
    ),
  );
}

/**
 * Quarantines a version for everyone (apps/web `src/shared/arena.ts`, "Quarantine"): sets
 * `versions.quarantined_at` and `quarantine_reason`, which bumps `change_seq` so the matchmaker's
 * poll sees it. The status stays as it is: quarantine isn't a ban.
 *
 * Idempotent: an earlier quarantine is kept (`WHERE quarantined_at IS NULL`). Checked through
 * `RETURNING`, since D1's `meta.changes` also counts rows that triggers change. Throws on D1
 * errors (retry); `missing` means the version row is gone (deleted with its bot), which no retry
 * can fix.
 */
export async function recordQuarantine(
  db: D1Database,
  q: QuarantineRecord,
): Promise<"recorded" | "missing"> {
  const [updated, existing] = await db.batch<{ id: string }>([
    db
      .prepare(
        `UPDATE versions SET quarantined_at = ?2, quarantine_reason = ?3,
          updated_at = cast(unixepoch('subsecond') * 1000 as integer)
         WHERE id = ?1 AND quarantined_at IS NULL
         RETURNING id`,
      )
      .bind(q.versionId, q.at, q.message),
    db.prepare("SELECT id FROM versions WHERE id = ?1").bind(q.versionId),
  ]);
  return updated?.results.length || existing?.results.length ? "recorded" : "missing";
}

/** Whether D1 has `versionId` quarantined (by any room). */
export async function isQuarantined(db: D1Database, versionId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT quarantined_at FROM versions WHERE id = ?1")
    .bind(versionId)
    .first<{ quarantined_at: number | null }>();
  return row?.quarantined_at != null;
}

/**
 * The arena's kill switch (apps/web `src/shared/arena.ts`, "Kill switch"): whether an admin
 * stopped the arena. A missing row means running.
 */
export async function arenaPaused(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT paused FROM arena_control WHERE id = 1")
    .first<{ paused: number }>();
  return Boolean(row?.paused);
}
