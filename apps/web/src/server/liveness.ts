/**
 * The scheduled liveness check (Cron Trigger, `triggers.crons` in wrangler.jsonc): are lives
 * still being recorded? A room that crashes for good, a matchmaker that stopped handing out
 * lives, or a D1 write path that broke all look the same from here: `lives` stops growing.
 *
 * Each run computes the minutes since the last sign of activity, the latest of
 * - the newest `lives` row (start or end), by `rowid` so it reads a few rows, not the table;
 * - the latest activation of a `ready` version (a first deploy has had no time to play yet);
 * - the last change of the kill switch (a resume has had no time either),
 *
 * and reports `stalled` when that's over `NO_LIVES_ALERT_MINUTES` (default 15) while the
 * arena isn't paused and has `ready` versions. With none, the arena only runs house bots,
 * which write no `lives` rows, so it's `idle`, not an alarm.
 *
 * Every run logs `arena.liveness` (level `error` with `alert: "no_lives"` when stalled) and
 * writes the `arena.liveness` metric; alerts are set up on either (README, "Alerts").
 */
import { log, type MetricsDataset, writeMetric } from "@zerosnake/observability";

export interface LivenessEnv {
  DB: D1Database;
  METRICS?: MetricsDataset;
  NO_LIVES_ALERT_MINUTES?: string;
}

export type LivenessStatus = "ok" | "idle" | "paused" | "stalled";

export interface Liveness {
  status: LivenessStatus;
  /** Since the latest activity (see the top of this file); `null` if there was never any. */
  minutesSinceActivity: number | null;
  readyVersions: number;
  thresholdMinutes: number;
  /** Unix ms of the newest life's start or end, if any. */
  lastLifeAt: number | null;
}

export const DEFAULT_NO_LIVES_ALERT_MINUTES = 15;

/** Newest `lives` rows looked at: an ended long life can be newer than the last insert. */
const RECENT_LIVES = 100;

export async function checkLiveness(env: LivenessEnv, now: Date): Promise<Liveness> {
  const configured = Number(env.NO_LIVES_ALERT_MINUTES);
  const thresholdMinutes =
    Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_NO_LIVES_ALERT_MINUTES;
  const row = await env.DB.prepare(
    `SELECT
      (SELECT paused FROM arena_control WHERE id = 1) AS paused,
      (SELECT updated_at FROM arena_control WHERE id = 1) AS control_at,
      (SELECT count(*) FROM versions WHERE status = 'ready') AS ready,
      (SELECT max(activated_at) FROM versions WHERE status = 'ready') AS activated_at,
      (SELECT max(max(started_at, coalesce(ended_at, 0)))
        FROM (SELECT started_at, ended_at FROM lives ORDER BY rowid DESC LIMIT ?1)) AS last_life`,
  )
    .bind(RECENT_LIVES)
    .first<{
      paused: number | null;
      control_at: number | null;
      ready: number;
      activated_at: number | null;
      last_life: number | null;
    }>();
  const readyVersions = row?.ready ?? 0;
  const lastLifeAt = row?.last_life ?? null;
  const latest = Math.max(lastLifeAt ?? 0, row?.activated_at ?? 0, row?.control_at ?? 0);
  const minutesSinceActivity =
    latest > 0 ? Math.max(0, Math.floor((now.getTime() - latest) / 60_000)) : null;

  const status: LivenessStatus = row?.paused
    ? "paused"
    : readyVersions === 0
      ? "idle"
      : minutesSinceActivity === null || minutesSinceActivity > thresholdMinutes
        ? "stalled"
        : "ok";
  return { status, minutesSinceActivity, readyVersions, thresholdMinutes, lastLifeAt };
}

/** The Cron Trigger's job: check, log, write the metric. Never throws (a failure is logged). */
export async function runLivenessCheck(env: LivenessEnv, now: Date) {
  try {
    const liveness = await checkLiveness(env, now);
    const stalled = liveness.status === "stalled";
    log(stalled ? "error" : "info", "arena.liveness", {
      ...liveness,
      ...(stalled ? { alert: "no_lives" } : {}),
    });
    writeMetric(env.METRICS, "arena.liveness", {
      status: liveness.status,
      minutesSinceActivity: liveness.minutesSinceActivity ?? -1,
      readyVersions: liveness.readyVersions,
      thresholdMinutes: liveness.thresholdMinutes,
    });
    return liveness;
  } catch (error) {
    log("error", "arena.liveness_failed", { error });
    return null;
  }
}
