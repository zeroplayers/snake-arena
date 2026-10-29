/**
 * The arena's writes to D1. The schema belongs to apps/web (`src/db/schema.ts`, migrations in
 * `apps/web/migrations/`); the row types below mirror the columns used here.
 */
import type { DeathCause } from "@zerosnake/engine";
import type { LifeResult, QuarantineRecord, VersionKillRecord } from "./protocol.ts";

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
    trace_key: r.traceKey ?? null,
    started_at: r.startedAt,
    ended_at: r.endedAt,
  };
}

/**
 * Inserts finished lives. Idempotent: a life already written is left alone. `evicted` lives are
 * skipped: `lives.death_cause` doesn't allow the value, and they mustn't count toward ratings.
 * So is a life of a version deleted meanwhile (its owner deleted the account, apps/web
 * `src/shared/account.ts`): the foreign key would fail the insert on every retry.
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
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14
           WHERE EXISTS (SELECT 1 FROM versions WHERE id = ?2) ON CONFLICT(id) DO NOTHING`,
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

const INSERT_KILL = `INSERT INTO version_kills (id, version_id, room, life_id, tick, retracted, at)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE EXISTS (SELECT 1 FROM versions WHERE id = ?2)`;

/**
 * Writes a named kill to `version_kills` (apps/web `src/db/schema.ts`) and quarantines its version
 * if that makes `threshold` unretracted kills of it from `since` on (any room's), with `message`
 * as the reason (as `recordQuarantine`; an earlier quarantine is kept). Idempotent: a kill already
 * written (or retracted) is left alone; a deleted version is skipped.
 *
 * Returns the count and whether the version is quarantined now (by this or anything else), so a
 * retry after a failed notification still reports it.
 */
export async function recordKill(
  db: D1Database,
  kill: VersionKillRecord,
  { threshold, since, message }: { threshold: number; since: number; message: string },
): Promise<{ kills: number; quarantined: boolean }> {
  const count = `(SELECT count(*) FROM version_kills
    WHERE version_id = ?1 AND at >= ?4 AND retracted = 0)`;
  const [, , state] = await db.batch<{ kills: number; quarantined: number }>([
    db
      .prepare(`${INSERT_KILL} ON CONFLICT(id) DO NOTHING`)
      .bind(kill.id, kill.versionId, kill.roomId, kill.lifeId, kill.tick, 0, kill.at),
    db
      .prepare(
        `UPDATE versions SET quarantined_at = ?2, quarantine_reason = ?3,
          updated_at = cast(unixepoch('subsecond') * 1000 as integer)
         WHERE id = ?1 AND quarantined_at IS NULL AND ${count} >= ?5`,
      )
      .bind(kill.versionId, kill.at, message, since, threshold),
    db
      .prepare(
        `SELECT ${count} AS kills, quarantined_at IS NOT NULL AS quarantined
         FROM versions WHERE id = ?1`,
      )
      .bind(kill.versionId, null, null, since),
  ]);
  const row = state?.results[0];
  return { kills: row?.kills ?? 0, quarantined: Boolean(row?.quarantined) };
}

/** Marks named kills as no evidence (written now if they weren't yet). Idempotent. */
export async function retractKills(db: D1Database, kills: VersionKillRecord[]): Promise<void> {
  if (kills.length === 0) return;
  await db.batch(
    kills.map((k) =>
      db
        .prepare(`${INSERT_KILL} ON CONFLICT(id) DO UPDATE SET retracted = 1`)
        .bind(k.id, k.versionId, k.roomId, k.lifeId, k.tick, 1, k.at),
    ),
  );
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

/**
 * The matchmaker's heartbeat (`arena_heartbeat`, apps/web `schema.ts`): when, and how many lives
 * it has in flight. Lives are written to `lives` only when they end, and last until the snake
 * dies, so the site's liveness check needs this to tell "strong bots alive for hours" from "no
 * lives at all".
 */
export async function recordHeartbeat(
  db: D1Database,
  beat: { at: number; livesInFlight: number; rooms: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO arena_heartbeat (id, at, lives_in_flight, rooms) VALUES (1, ?1, ?2, ?3)
       ON CONFLICT (id) DO UPDATE SET at = excluded.at, lives_in_flight = excluded.lives_in_flight,
         rooms = excluded.rooms`,
    )
    .bind(beat.at, beat.livesInFlight, beat.rooms)
    .run();
}
