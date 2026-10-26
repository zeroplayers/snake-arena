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

/** `versions.report` (apps/web `CheckReport`): the deploy checks' result, shown by the CLI. */
export interface CheckReport {
  ok: boolean;
  checks: { name: string; ok: boolean; message?: string }[];
  qualificationScore?: number;
}

/** The check the arena appends to a version's report when the backstop bans it. */
export const BAN_CHECK = "arena-backstop";

/** The version's report with the ban appended as a failed check, keeping the earlier checks. */
export function banReport(report: CheckReport | null, ban: BanRecord): CheckReport {
  const checks = (report?.checks ?? []).filter((c) => c.name !== BAN_CHECK);
  checks.push({ name: BAN_CHECK, ok: false, message: ban.message });
  return { ...report, ok: false, checks };
}

/**
 * Records a backstop ban: the version leaves the arena for good. `versions.status` has no
 * `banned` value, so it becomes `rejected`, and the report gets a failed `arena-backstop` check.
 * Idempotent.
 */
export async function recordBan(db: D1Database, ban: BanRecord): Promise<void> {
  const row = await db
    .prepare("SELECT report FROM versions WHERE id = ?")
    .bind(ban.versionId)
    .first<{ report: string | null }>();
  if (!row) return;
  const report = banReport(row.report ? (JSON.parse(row.report) as CheckReport) : null, ban);
  await db
    .prepare(
      `UPDATE versions SET status = 'rejected', report = ?,
        updated_at = cast(unixepoch('subsecond') * 1000 as integer)
       WHERE id = ?`,
    )
    .bind(JSON.stringify(report), ban.versionId)
    .run();
}
