/**
 * Retention of life traces (R2 `TRACES`, `TRACE_RETENTION_DAYS`). Production buckets also have an
 * R2 lifecycle rule ("Trace retention" in the root README); this sweep, from the cron, is the same
 * rule for buckets without one (local dev, a new environment) and costs one list call when there
 * is nothing to do.
 *
 * Keys start with the UTC day the life ended (`traceKey`), so listing from the start of the
 * bucket returns the oldest first: delete until the first key that is young enough.
 */
import { TRACE_RETENTION_DAYS } from "@zerosnake/web/shared";

const DAY_MS = 86_400_000;
/** Most list pages (1000 keys each) one sweep goes through. */
export const SWEEP_PAGES = 10;

/** Deletes traces whose day is more than `TRACE_RETENTION_DAYS` before `now`'s; returns how many. */
export async function sweepTraces(bucket: R2Bucket, now: number): Promise<number> {
  const cutoff = new Date(now - TRACE_RETENTION_DAYS * DAY_MS).toISOString().slice(0, 10);
  let deleted = 0;
  let cursor: string | undefined;
  for (let page = 0; page < SWEEP_PAGES; page++) {
    const listed = await bucket.list({ limit: 1000, ...(cursor && { cursor }) });
    const old = listed.objects.map((o) => o.key).filter((key) => key.slice(0, 10) < cutoff);
    if (old.length > 0) await bucket.delete(old);
    deleted += old.length;
    if (old.length < listed.objects.length || !listed.truncated) break;
    cursor = listed.cursor;
  }
  return deleted;
}
