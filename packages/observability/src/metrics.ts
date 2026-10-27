/**
 * Counters and measurements written to Workers Analytics Engine (`analytics_engine_datasets`),
 * one dataset per environment shared by both workers (`zerosnake_dev`, `zerosnake_staging`).
 *
 * Every event has a fixed column layout, so dashboards and alert queries can rely on it:
 *
 * | column    | holds                                                        |
 * | --------- | ------------------------------------------------------------ |
 * | `index1`  | the event name (Analytics Engine samples per index)          |
 * | `blob1`   | the event name                                               |
 * | `blob2`   | the worker that wrote it: `web` or `arena`                   |
 * | `blob3…`  | the event's `blobs`, in the order listed in `METRICS`        |
 * | `double1` | 1, so `SUM(_sample_interval * double1)` counts events        |
 * | `double2…`| the event's `doubles`, in the order listed in `METRICS`      |
 *
 * `metricColumns(name)` gives the mapping for one event. Never reorder or reuse a position:
 * add new fields at the end, or add a new event.
 *
 * Writing is fire and forget (`writeDataPoint` doesn't wait) and never throws: a missing binding
 * (tests, a worker without the dataset) or a failed write only skips the point.
 */

/** The part of an Analytics Engine dataset binding that's used here. */
export interface MetricsDataset {
  writeDataPoint(point?: {
    indexes?: (string | null)[];
    blobs?: (string | null)[];
    doubles?: number[];
  }): void;
}

export type MetricSource = "web" | "arena";

interface MetricSchema {
  readonly source: MetricSource;
  readonly blobs: readonly string[];
  readonly doubles: readonly string[];
}

/**
 * Every event either worker writes. `apps/arena` events are the contract for the rooms, the
 * matchmaker and the checks consumer; the site doesn't write them.
 */
export const METRICS = {
  // ─── apps/web ──────────────────────────────────────────────────────────────────────────────
  /** A deploy request made a version (201) or replayed one (200, an idempotent retry). */
  "deploy.accepted": { source: "web", blobs: ["userId"], doubles: ["status"] },
  /** A deploy request that made nothing; `reason` is the `ApiErrorBody.error` code. */
  "deploy.rejected": { source: "web", blobs: ["reason", "userId"], doubles: ["status"] },
  /**
   * A 5xx response or an exception, on the API (`route` is its pattern) or a page (`route` is
   * `page`). `outcome` is the error code, `http_<status>` or `exception`. Alert on any.
   */
  "http.error": { source: "web", blobs: ["route", "outcome"], doubles: ["status"] },
  /** A request refused by a rate limiter; `rule` is the `RATE_LIMITS` key. */
  "ratelimit.limited": { source: "web", blobs: ["rule", "route"], doubles: [] },
  /**
   * Authentication that didn't work: `cli_token` (a missing, expired or revoked CLI token),
   * `session` (a site call without a session), `oauth` (a sign-in that came back with an error),
   * `auth_api` (a 401/403 from Better Auth).
   */
  "auth.failure": { source: "web", blobs: ["kind", "route"], doubles: ["status"] },
  /** An admin action (`src/server/moderation.ts` in apps/web). */
  "moderation.action": { source: "web", blobs: ["action"], doubles: [] },
  /**
   * The scheduled liveness check (apps/web cron): `status` is `ok`, `idle` (no ready versions),
   * `exhausted` (every bot used its daily lives), `paused` (kill switch on) or `stalled`
   * (playable versions but no lives for too long: alert).
   */
  "arena.liveness": {
    source: "web",
    blobs: ["status"],
    doubles: ["minutesSinceActivity", "readyVersions", "thresholdMinutes", "playableVersions"],
  },
  /**
   * The replay retention sweep (apps/web cron every 30 minutes, `src/server/replays.ts`).
   * `outcome`: `done` (every room looked at), `more` (stopped at the per-run budget; the next run
   * carries on), `no_pins` (the pinned lives couldn't be read, so nothing was deleted) or
   * `failed`. Alert on `no_pins` or `failed` lasting: replays pile up meanwhile.
   */
  "replays.swept": {
    source: "web",
    blobs: ["outcome"],
    doubles: [
      "deleted",
      "pinnedChunks",
      "pinnedLives",
      "expiredLives",
      "rooms",
      "roomsSwept",
      "lists",
      "durationMs",
    ],
  },

  // ─── apps/arena ────────────────────────────────────────────────────────────────────────────
  /** A room started (`RoomRpc.start`). */
  "room.started": { source: "arena", blobs: ["roomId", "mode"], doubles: ["maxSnakes"] },
  /**
   * A room's batches since its last `room.batch`, written at most every `RoomLimits.metricsMs`
   * (30 s) per room, never per tick. `mode` is the one it runs in now (real time while
   * spectators watch). Sums over the period: `ticks`, `workUnits` (the sandbox's cost units, a
   * deterministic CPU proxy: workerd doesn't expose CPU time to code; DO CPU itself is in the
   * Durable Objects metrics), `botTicks`, `batches`, `livesStarted` / `livesEnded` (real lives),
   * `wallMs` (batch wall time, which the frozen clock only moves on I/O), `watched` (batches in
   * watch mode) and `cut` (batches watch mode ended early). Now: `snakes`, `spectators`, `tick`
   * (the world's; a room whose `tick` doesn't move is stuck). `periodMs` is the time the sums
   * cover, so `ticks / periodMs * 1000` is the room's ticks per second. `maxWallMs`: the
   * period's slowest batch.
   */
  "room.batch": {
    source: "arena",
    blobs: ["roomId", "mode"],
    doubles: [
      "ticks",
      "snakes",
      "workUnits",
      "botTicks",
      "batches",
      "livesStarted",
      "livesEnded",
      "wallMs",
      "maxWallMs",
      "periodMs",
      "spectators",
      "watched",
      "cut",
      "tick",
    ],
  },
  /**
   * An incident of the room's CPU backstop, or an alarm that threw. `cause`: `restart` (a batch
   * died too young to be the CPU limit: deploys, evictions; counts for nothing), `overrun` (a
   * batch died, possibly by the CPU limit, naming no one), `suspect` / `evicted` (a watched kill
   * named a call; `evicted` when that evicted its life), `overran` (a watched call returned after
   * running past the abort share: named like a kill), `exception` (the alarm threw). `restarts`:
   * the room's incidents in the backstop's window (24 h), this one included. `versionId`: the
   * version a kill named. Alert on any but `restart`.
   */
  "room.crashed": {
    source: "arena",
    blobs: ["roomId", "cause", "versionId"],
    doubles: ["restarts", "gapMs", "callMs"],
  },
  /**
   * A room closed: `empty` (only house bots left, nothing queued) or `kill_switch` (the arena is
   * stopped). `ticks`: its world's tick; `lives`: lives that ended in it; `durationMs` since
   * `start` (0 for rooms started before this was recorded).
   */
  "room.closed": {
    source: "arena",
    blobs: ["roomId", "reason"],
    doubles: ["ticks", "lives", "durationMs"],
  },
  /**
   * A life of a version ended and the room delivered it (its `lives` row is written, except for
   * `evicted` lives, which get none). Counting these by `deathCause` gives lives per hour.
   */
  "life.ended": {
    source: "arena",
    blobs: ["versionId", "deathCause", "roomId"],
    doubles: ["score", "ticks", "kills", "durationMs"],
  },
  /**
   * The room's backstop evicted a life (`versionId` null for a house bot). `evictions`: the
   * version's evictions in this room; `versionKills`: kills naming it in the tally.
   */
  "room.evicted": {
    source: "arena",
    blobs: ["roomId", "versionId"],
    doubles: ["evictions", "versionKills"],
  },
  /**
   * A version was quarantined: `by` a room (`room`: its evictions or kills there), by kills
   * across rooms (`kills`, D1's tally) or by the matchmaker (`matchmaker`: evictions across
   * rooms).
   */
  "version.quarantined": {
    source: "arena",
    blobs: ["versionId", "by", "roomId"],
    doubles: ["evictions", "kills"],
  },
  /**
   * The checks consumer finished a job. `outcome`: `ready`, `superseded`, `rejected`,
   * `unchanged` (already done: a redelivery), `missing` (no version row), `failed` (an error on
   * our side; the job is retried), `dead_letter` (out of retries: rejected), `malformed` (not a
   * job), `reaped` (the cron rejected a version left `validating`). `reason`: for `rejected`
   * and `reaped` the `FailureReason`, or the first failed check; for `failed` the error message;
   * for `dead_letter` whether it `rejected` the version or found it done (`unchanged`).
   * `durationMs`: the job's wall time (CPU included: the clock catches up at the next I/O).
   * `attempt`: the delivery number (0 when reaped).
   */
  "checks.finished": {
    source: "arena",
    blobs: ["outcome", "reason"],
    doubles: ["durationMs", "attempt"],
  },
  /**
   * The matchmaker's snapshot, at most once a minute (from its alarm). `rooms`: open (and
   * opening) rooms; `liveSnakes`: lives issued and not reported back; `queuedLives`: bots whose
   * next life can be issued now; `readyVersions`: bots with a playable version; `exhausted`:
   * those that used today's quota; `paused`: 1 while the kill switch is on.
   */
  "arena.gauge": {
    source: "arena",
    blobs: [],
    doubles: ["rooms", "liveSnakes", "queuedLives", "readyVersions", "exhausted", "paused"],
  },
  /**
   * The matchmaker's room check (every minute per room) found a running room whose world tick
   * didn't move for `stalledMs`: `reason` is `outbox_full` (D1, R2 or the matchmaker failing)
   * or `no_progress`. Alert on any.
   */
  "room.stalled": {
    source: "arena",
    blobs: ["roomId", "reason"],
    doubles: ["tick", "stalledMs", "outbox"],
  },
} as const satisfies Record<string, MetricSchema>;

export type MetricName = keyof typeof METRICS;

type Schema<N extends MetricName> = (typeof METRICS)[N];

/** The fields of an event: its blobs as strings (or `null`), its doubles as numbers. */
export type MetricFields<N extends MetricName> = {
  [K in Schema<N>["blobs"][number]]: string | null;
} & {
  [K in Schema<N>["doubles"][number]]: number;
};

/** Blobs over this many bytes are cut (Analytics Engine allows 16 KB for all blobs together). */
const MAX_BLOB_LENGTH = 256;

/** The data point for an event, laid out as described at the top of this file. */
export function metricPoint<N extends MetricName>(name: N, fields: MetricFields<N>) {
  const schema: MetricSchema = METRICS[name];
  const values = fields as Record<string, string | number | null>;
  const blobs = schema.blobs.map((key) => {
    const value = values[key];
    return typeof value === "string" ? value.slice(0, MAX_BLOB_LENGTH) : null;
  });
  const doubles = schema.doubles.map((key) => {
    const value = values[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  });
  return {
    indexes: [name],
    blobs: [name, schema.source, ...blobs],
    doubles: [1, ...doubles],
  };
}

/** Writes one event; never throws (see the top of this file). */
export function writeMetric<N extends MetricName>(
  dataset: MetricsDataset | undefined,
  name: N,
  fields: MetricFields<N>,
) {
  if (!dataset) return;
  try {
    dataset.writeDataPoint(metricPoint(name, fields));
  } catch {
    // A metric is never worth failing a request over.
  }
}

/** Column names of one event's fields, e.g. `{ reason: "blob3", status: "double2" }`. */
export function metricColumns(name: MetricName): Record<string, string> {
  const schema: MetricSchema = METRICS[name];
  return Object.fromEntries([
    ...schema.blobs.map((key, i) => [key, `blob${i + 3}`]),
    ...schema.doubles.map((key, i) => [key, `double${i + 2}`]),
  ]);
}
