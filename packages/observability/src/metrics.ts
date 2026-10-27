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

  // ─── apps/arena ────────────────────────────────────────────────────────────────────────────
  /** A room started (`RoomRpc.start`). */
  "room.started": { source: "arena", blobs: ["roomId", "mode"], doubles: ["maxSnakes"] },
  /**
   * One alarm batch of a room. `ticks / period` over all rooms is the arena's ticks per second;
   * `workUnits` is the sandbox's cost units for the batch (a deterministic CPU proxy: workerd
   * doesn't expose CPU time to the code; DO CPU itself is in the Durable Objects metrics).
   */
  "room.batch": {
    source: "arena",
    blobs: ["roomId", "mode"],
    doubles: ["ticks", "snakes", "workUnits"],
  },
  /**
   * A room's isolate died or an alarm threw and the room recovered from storage. `cause` is
   * e.g. `cpu_limit`, `exception`, `restart`. Alert on any.
   */
  "room.crashed": { source: "arena", blobs: ["roomId", "cause"], doubles: ["restarts"] },
  /** A room closed (no real lives left), or was closed by the kill switch. */
  "room.closed": {
    source: "arena",
    blobs: ["roomId", "reason"],
    doubles: ["ticks", "lives", "durationMs"],
  },
  /** A life ended and its `lives` row is written. Counting these gives lives per hour. */
  "life.ended": {
    source: "arena",
    blobs: ["versionId", "deathCause", "roomId"],
    doubles: ["score", "ticks", "kills"],
  },
  /** The room backstop banned a version (`reason`: `cpu` or `slow`). */
  "version.banned": { source: "arena", blobs: ["versionId", "reason"], doubles: [] },
  /** The checks consumer finished a version (`outcome`: `ready`, `rejected`, `archived`). */
  "checks.finished": {
    source: "arena",
    blobs: ["outcome", "reason"],
    doubles: ["durationMs"],
  },
  /** The matchmaker's periodic snapshot (at most once a minute). */
  "arena.gauge": {
    source: "arena",
    blobs: [],
    doubles: ["rooms", "liveSnakes", "queuedLives", "readyVersions"],
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
