/**
 * Structured logs. Each call writes one object with `level`, `event` and its fields; Workers Logs
 * (`observability.enabled` in wrangler config) indexes the fields, so the dashboard's query
 * builder can filter on `event`, `requestId`, `userId`, `route`, `outcome`… `wrangler tail
 * --format json` and Logpush give the same records as JSON lines.
 *
 * Conventions for fields (keep them, so one query covers both workers):
 * - `event`: dotted name, e.g. `api.request`, `arena.liveness`, `room.crashed`
 * - `requestId` (the `cf-ray` of the request, or a UUID), `userId`, `route` (the route pattern,
 *   not the raw path), `method`, `status`, `latencyMs`, `outcome` (an error code or `ok`)
 * - `error`: an `Error` is written as `{ name, message, stack }`
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

interface Console {
  log(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
  debug(...data: unknown[]): void;
}

declare const console: Console;

/** `Error`s become plain objects (they'd otherwise log as `{}`); other values pass through. */
function plain(value: unknown, depth = 0): unknown {
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    if (value.cause !== undefined && depth < 3) out.cause = plain(value.cause, depth + 1);
    return out;
  }
  return value;
}

export function log(level: LogLevel, event: string, fields: LogFields = {}) {
  const record: LogFields = { level, event };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) record[key] = plain(value);
  }
  const write =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : level === "debug"
          ? console.debug
          : console.log;
  write(record);
}

/** A logger with fields every record shares (e.g. `requestId`, `worker`). */
export function logger(base: LogFields) {
  const write =
    (level: LogLevel) =>
    (event: string, fields: LogFields = {}) =>
      log(level, event, { ...base, ...fields });
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  };
}

export type Logger = ReturnType<typeof logger>;
