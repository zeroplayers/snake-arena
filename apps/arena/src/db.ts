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

/** `versions.report` (apps/web `CheckReport`): the deploy checks' result, shown by the CLI. */
export interface CheckReport {
  ok: boolean;
  checks: { name: string; ok: boolean; message?: string }[];
  qualificationScore?: number;
}

/** The check the arena appends to a version's report when the backstop quarantines it. */
export const BACKSTOP_CHECK = "arena-backstop";

/**
 * The version's report with the quarantine note appended as a failed `arena-backstop` check,
 * keeping the earlier checks and `ok` (the deploy checks did pass; the version stays `ready`).
 */
export function quarantineReport(report: CheckReport | null, q: QuarantineRecord): CheckReport {
  const checks = (report?.checks ?? []).filter((c) => c.name !== BACKSTOP_CHECK);
  checks.push({ name: BACKSTOP_CHECK, ok: false, message: q.message });
  return report ? { ...report, checks } : { ok: true, checks };
}

/** Attempts at the report's compare-and-swap before giving up (the outbox retries later). */
const REPORT_CAS_ATTEMPTS = 5;

/**
 * Notes a quarantine in D1 for review: appends the failed `arena-backstop` check to
 * `versions.report`. `versions` has no quarantine column yet (the matchmaker keeps the list
 * itself), and the status stays as it is: quarantine isn't a ban.
 *
 * Idempotent. The report is a compare-and-swap (`WHERE report IS <what we read>`), checked through
 * `RETURNING` (D1's `meta.changes` also counts rows that triggers change), so a concurrent write
 * of the report isn't lost and a row deleted in between isn't reported as `recorded`. Throws on D1
 * errors and on persistent contention (retry); `missing` means the version row is gone (deleted
 * with its bot), which no retry can fix.
 */
export async function recordQuarantine(
  db: D1Database,
  q: QuarantineRecord,
): Promise<"recorded" | "missing"> {
  for (let attempt = 0; attempt < REPORT_CAS_ATTEMPTS; attempt++) {
    const row = await db
      .prepare("SELECT report FROM versions WHERE id = ?")
      .bind(q.versionId)
      .first<{ report: string | null }>();
    if (!row) return "missing";
    const report = quarantineReport(row.report ? (JSON.parse(row.report) as CheckReport) : null, q);
    const updated = await db
      .prepare(
        `UPDATE versions SET report = ?1,
          updated_at = cast(unixepoch('subsecond') * 1000 as integer)
         WHERE id = ?2 AND report IS ?3
         RETURNING id`,
      )
      .bind(JSON.stringify(report), q.versionId, row.report)
      .first<{ id: string }>();
    if (updated) return "recorded";
  }
  throw new Error(`versions.report of ${q.versionId} kept changing; will retry`);
}
