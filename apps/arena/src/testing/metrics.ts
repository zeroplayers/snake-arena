/**
 * A stand-in for the `METRICS` Analytics Engine binding in workerd tests (Miniflare's own keeps
 * nothing the test could read). The harnesses set `TEST_METRICS` (a JSON var):
 *
 * - `"record"`: every data point is kept (a Durable Object keeps its own in its storage, so they
 *   survive restarts like the object; the checks worker keeps them in memory);
 * - `"throw"`: every write throws, as a broken binding would;
 * - unset: `METRICS` stays as configured, which in the harnesses means absent.
 */
import { METRICS, type MetricName, type MetricsDataset } from "@zerosnake/observability";

export type DataPoint = NonNullable<Parameters<MetricsDataset["writeDataPoint"]>[0]>;

/** `env` with `METRICS` replaced as `TEST_METRICS` says, writing points to `sink`. */
export function withTestMetrics<E extends object>(env: E, sink: (point: DataPoint) => void): E {
  const mode = (env as { TEST_METRICS?: "record" | "throw" }).TEST_METRICS;
  if (!mode) return env;
  const dataset: MetricsDataset = {
    writeDataPoint(point = {}) {
      if (mode === "throw") throw new Error("Analytics Engine is down (test)");
      sink(point);
    },
  };
  return { ...env, METRICS: dataset };
}

/** Points kept in a Durable Object's SQLite storage. */
export function sqlPoints(sql: SqlStorage) {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS test_metrics (seq INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT)",
  );
  return {
    write: (point: DataPoint) => {
      sql.exec("INSERT INTO test_metrics (json) VALUES (?)", JSON.stringify(point));
    },
    read: (): DataPoint[] =>
      sql
        .exec<{ json: string }>("SELECT json FROM test_metrics ORDER BY seq")
        .toArray()
        .map((r) => JSON.parse(r.json)),
  };
}

export interface Metric {
  name: MetricName;
  /** `blob2`: the worker. */
  source: string;
  /** The event's fields by name (`METRICS` in `@zerosnake/observability`). */
  fields: Record<string, string | number | null>;
}

/** A data point read back by the event's schema, checking its fixed layout on the way. */
export function readPoint(point: DataPoint): Metric {
  const [name, source, ...blobs] = point.blobs ?? [];
  const [count, ...doubles] = point.doubles ?? [];
  const schema = METRICS[name as MetricName];
  if (!schema || point.indexes?.[0] !== name || count !== 1) {
    throw new Error(`not a metric point: ${JSON.stringify(point)}`);
  }
  if (blobs.length !== schema.blobs.length || doubles.length !== schema.doubles.length) {
    throw new Error(`${name}: wrong number of fields: ${JSON.stringify(point)}`);
  }
  const fields: Metric["fields"] = {};
  schema.blobs.forEach((key, i) => {
    fields[key] = blobs[i] ?? null;
  });
  schema.doubles.forEach((key, i) => {
    fields[key] = doubles[i] ?? null;
  });
  return { name: name as MetricName, source: source ?? "", fields };
}

/** The fields of every point of event `name`, in order. */
export function metricsNamed(points: DataPoint[], name: MetricName): Metric["fields"][] {
  return points
    .map(readPoint)
    .filter((m) => m.name === name)
    .map((m) => m.fields);
}
