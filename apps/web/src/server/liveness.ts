/**
 * The scheduled liveness check (Cron Trigger, `triggers.crons` in wrangler.jsonc): are lives
 * still being recorded? A room that crashes for good, a matchmaker that stopped handing out
 * lives, or a D1 write path that broke all look the same from here: `lives` stops growing.
 *
 * Each run computes the minutes since the last sign of activity, the latest of
 * - the newest `lives` row (start or end), by `rowid` so it reads a few rows, not the table;
 * - the latest activation of a `ready` version (a first deploy has had no time to play yet);
 * - the last change of the kill switch (a resume has had no time either);
 * - the matchmaker's latest heartbeat (`arena_heartbeat`, about every minute) while it reports
 *   lives in flight: a life is written to `lives` only when it ends, and lives last until the
 *   snake dies (up to 24 hours of game time), so an arena of a few strong bots can go hours
 *   without a new row while playing fine. A matchmaker that stops beating, or beats with no lives
 *   out while bots wait, still alerts;
 * - 00:00 UTC today (quotas reset then, and the matchmaker has had no time to use them),
 *
 * and reports `stalled` when that's over `NO_LIVES_ALERT_MINUTES` (default 15) while the
 * arena isn't paused and has playable versions: `ready` ones whose bot hasn't started
 * `ARENA_LIMITS.livesPerBotPerDay` lives today. Without any, the matchmaker rightly starts no
 * lives:
 * - no `ready` versions at all: the arena only runs house bots, which write no `lives` rows,
 *   so it's `idle`;
 * - `ready` versions, but every bot's quota used up (common on a small arena late in the day):
 *   `exhausted`, until 00:00 UTC.
 *
 * Every run logs `arena.liveness` (level `error` with `alert: "no_lives"` when stalled) and
 * writes the `arena.liveness` metric; alerts are set up on either (README, "Alerts").
 */
import { log, type MetricsDataset, writeMetric } from "@zerosnake/observability";
import { ARENA_LIMITS } from "../shared/arena";

export interface LivenessEnv {
  DB: D1Database;
  METRICS?: MetricsDataset;
  NO_LIVES_ALERT_MINUTES?: string;
}

export type LivenessStatus = "ok" | "idle" | "exhausted" | "paused" | "stalled";

export interface Liveness {
  status: LivenessStatus;
  /** Since the latest activity (see the top of this file); `null` if there was never any. */
  minutesSinceActivity: number | null;
  readyVersions: number;
  /** `ready` versions whose bot may still start a life today (`ARENA_LIMITS`). */
  playableVersions: number;
  thresholdMinutes: number;
  /** Unix ms of the newest life's start or end, if any. */
  lastLifeAt: number | null;
  /** Lives the matchmaker had in flight at its latest heartbeat (0 without one). */
  livesInFlight: number;
}

export const DEFAULT_NO_LIVES_ALERT_MINUTES = 15;

/** Newest `lives` rows looked at: an ended long life can be newer than the last insert. */
const RECENT_LIVES = 100;

export async function checkLiveness(env: LivenessEnv, now: Date): Promise<Liveness> {
  const configured = Number(env.NO_LIVES_ALERT_MINUTES);
  const thresholdMinutes =
    Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_NO_LIVES_ALERT_MINUTES;
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  // Lives a bot started today, over all its versions. A life started today ended today or is
  // still running, so `ended_at` narrows the `lives_version_ended_idx` range per version.
  const row = await env.DB.prepare(
    `SELECT
      (SELECT paused FROM arena_control WHERE id = 1) AS paused,
      (SELECT updated_at FROM arena_control WHERE id = 1) AS control_at,
      (SELECT count(*) FROM versions WHERE status = 'ready') AS ready,
      (SELECT count(*) FROM versions AS r WHERE r.status = 'ready' AND (
        SELECT count(*) FROM versions AS v JOIN lives AS l ON l.version_id = v.id
        WHERE v.bot_id = r.bot_id AND (l.ended_at IS NULL OR l.ended_at >= ?2)
          AND l.started_at >= ?2
      ) < ?3) AS playable,
      (SELECT max(activated_at) FROM versions WHERE status = 'ready') AS activated_at,
      (SELECT max(max(started_at, coalesce(ended_at, 0)))
        FROM (SELECT started_at, ended_at FROM lives ORDER BY rowid DESC LIMIT ?1)) AS last_life,
      (SELECT at FROM arena_heartbeat WHERE id = 1) AS beat_at,
      (SELECT lives_in_flight FROM arena_heartbeat WHERE id = 1) AS in_flight`,
  )
    .bind(RECENT_LIVES, dayStart, ARENA_LIMITS.livesPerBotPerDay)
    .first<{
      paused: number | null;
      control_at: number | null;
      ready: number;
      playable: number;
      activated_at: number | null;
      last_life: number | null;
      beat_at: number | null;
      in_flight: number | null;
    }>();
  const readyVersions = row?.ready ?? 0;
  const playableVersions = row?.playable ?? 0;
  const lastLifeAt = row?.last_life ?? null;
  const livesInFlight = row?.in_flight ?? 0;
  // Lives in flight are activity: they will be written when they end.
  const beatAt = livesInFlight > 0 ? (row?.beat_at ?? 0) : 0;
  const latest = Math.max(lastLifeAt ?? 0, row?.activated_at ?? 0, row?.control_at ?? 0, beatAt);
  const minutesSinceActivity =
    latest > 0 ? Math.max(0, Math.floor((now.getTime() - latest) / 60_000)) : null;
  // The quota reset is a fresh start, but not a sign of activity to report.
  const minutesSinceStart = Math.floor((now.getTime() - Math.max(latest, dayStart)) / 60_000);

  const status: LivenessStatus = row?.paused
    ? "paused"
    : readyVersions === 0
      ? "idle"
      : playableVersions === 0
        ? "exhausted"
        : minutesSinceStart > thresholdMinutes
          ? "stalled"
          : "ok";
  return {
    status,
    minutesSinceActivity,
    readyVersions,
    playableVersions,
    thresholdMinutes,
    lastLifeAt,
    livesInFlight,
  };
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
      playableVersions: liveness.playableVersions,
    });
    return liveness;
  } catch (error) {
    log("error", "arena.liveness_failed", { error });
    return null;
  }
}
