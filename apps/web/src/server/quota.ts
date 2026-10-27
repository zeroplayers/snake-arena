/**
 * The daily deploy quota (`DEPLOY_LIMITS.deploysPerDay`), shared by the CLI API and the site.
 *
 * It counts every way a version can start a fresh rating: versions created today (except
 * deploys that failed before being queued) plus rollbacks made today (`activations` of kind
 * `activate`). A rollback restarts the version's rating, so if it were free, rolling back over
 * and over until one run of 30 lives came out lucky would get around the quota.
 */
import { count, type SQLWrapper, sql } from "drizzle-orm";
import type { Db } from "../db";
import { activations, bots, versions } from "../db/schema";
import type { QuotaInfo } from "../shared/deploy";

export const DAY_MS = 24 * 60 * 60 * 1000;

export function utcDayStart(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Versions that never got queued (`abandon`ed) don't use up the daily quota. */
export const countsAgainstQuota = (v: SQLWrapper) =>
  sql`NOT (${v}.enqueued_at IS NULL AND ${v}.status = 'rejected')`;

/** SQL expression: deploys plus rollbacks `ownerId` made since `dayStart`. */
export function quotaUsedSql(ownerId: string, dayStart: Date) {
  const since = dayStart.getTime();
  return sql<number>`(
    (SELECT ${count()} FROM ${versions} AS v JOIN ${bots} AS b ON b.id = v.bot_id
      WHERE b.owner_id = ${ownerId} AND v.created_at >= ${since} AND ${countsAgainstQuota(sql`v`)})
    + (SELECT ${count()} FROM ${activations} AS a
      WHERE a.owner_id = ${ownerId} AND a.created_at >= ${since} AND a.kind = 'activate')
  )`;
}

export async function deployQuota(
  db: Db,
  ownerId: string,
  now: Date,
  deploysPerDay: number,
): Promise<QuotaInfo> {
  const dayStart = utcDayStart(now);
  const [row] = await db.all<{ used: number }>(
    sql`SELECT ${quotaUsedSql(ownerId, dayStart)} AS used`,
  );
  return {
    deploysToday: row?.used ?? 0,
    deploysPerDay,
    resetsAt: new Date(dayStart.getTime() + DAY_MS).toISOString(),
  };
}
