/**
 * Real D1 (workerd, via wrangler's platform proxy) for tests, migrated with the same SQL files
 * `wrangler d1 migrations apply` uses, plus R2 and Queues for the CLI API. Nothing is persisted.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, unstable_splitSqlQuery as splitSqlQuery } from "wrangler";
import { RATE_LIMITS, type RateLimitBinding, type RateLimitRule } from "../server/rate-limit";

const appDir = join(import.meta.dirname, "../..");
export const migrationsDir = join(appDir, "migrations");
export const seedFile = join(appDir, "seed/dev.sql");

export interface TestD1 {
  db: D1Database;
  dispose(): Promise<void>;
}

export async function createTestD1({
  seed = false,
  migrateBefore,
}: Pick<TestPlatformOptions, "seed" | "migrateBefore"> = {}): Promise<TestD1> {
  const { env, dispose } = await createTestPlatform({ seed, migrateBefore });
  return { db: env.DB, dispose };
}

/**
 * What the CLI API needs besides D1: the R2 buckets and the checks queue producer, plus the
 * rate limiters (Miniflare's, exact within one process).
 */
export interface TestPlatformEnv {
  DB: D1Database;
  BUNDLES: R2Bucket;
  SOURCES: R2Bucket;
  TRACES: R2Bucket;
  REPLAYS: R2Bucket;
  CHECKS_QUEUE: Queue;
  RATE_LIMIT_IP: RateLimitBinding;
  RATE_LIMIT_AUTH: RateLimitBinding;
  RATE_LIMIT_USER: RateLimitBinding;
  RATE_LIMIT_DEPLOY: RateLimitBinding;
}

export interface TestPlatformOptions {
  seed?: boolean;
  /** Applies only the migrations sorting before this file name (to test a migration on data). */
  migrateBefore?: string | undefined;
  /** Overrides the `limit` of rate limit rules (the defaults are `RATE_LIMITS`). */
  rateLimits?: Partial<Record<RateLimitRule, number>>;
}

/** D1 plus local R2 buckets, a queue producer and rate limiters (Miniflare), nothing persisted. */
export async function createTestPlatform({
  seed = false,
  rateLimits = {},
  migrateBefore,
}: TestPlatformOptions = {}) {
  // A config with nothing but these bindings, so the proxy doesn't look for apps/arena.
  const dir = mkdtempSync(join(tmpdir(), "zerosnake-d1-"));
  const configPath = join(dir, "wrangler.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "zerosnake-web-test",
      compatibility_date: "2026-10-15",
      d1_databases: [{ binding: "DB", database_name: "test", database_id: "test" }],
      r2_buckets: [
        { binding: "BUNDLES", bucket_name: "test-bundles" },
        { binding: "SOURCES", bucket_name: "test-sources" },
        { binding: "TRACES", bucket_name: "test-traces" },
        { binding: "REPLAYS", bucket_name: "test-replays" },
      ],
      queues: { producers: [{ binding: "CHECKS_QUEUE", queue: "test-checks" }] },
      ratelimits: Object.entries(RATE_LIMITS).map(([rule, { binding, limit, period }], i) => ({
        name: binding,
        namespace_id: String(9001 + i),
        simple: { limit: rateLimits[rule as RateLimitRule] ?? limit, period },
      })),
    }),
  );
  const proxy = await getPlatformProxy<TestPlatformEnv>({
    configPath,
    persist: false,
    envFiles: [],
    remoteBindings: false,
  });
  await applyMigrations(proxy.env.DB, migrateBefore);
  if (seed) await execFile(proxy.env.DB, seedFile);
  return {
    env: proxy.env,
    dispose: async () => {
      await proxy.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Applies the migrations in order: all of them, or those sorting before `before`. */
export async function applyMigrations(db: D1Database, before?: string, from?: string) {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql") && (!before || f < before) && (!from || f >= from))
    .sort();
  for (const file of files) await execFile(db, join(migrationsDir, file));
}

/** Runs a SQL file the way `wrangler d1 execute --file` does. */
export async function execFile(db: D1Database, path: string) {
  const statements = splitSqlQuery(readFileSync(path, "utf8"));
  await db.batch(statements.map((s) => db.prepare(s)));
}
