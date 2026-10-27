/**
 * Real D1 (workerd, via wrangler's platform proxy) for tests, migrated with the same SQL files
 * `wrangler d1 migrations apply` uses, plus KV for web sessions and R2 and Queues for the CLI
 * API. Nothing is persisted.
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
  /** Better Auth's web sessions (`AUTH_KV`). */
  kv: KVNamespace;
  dispose(): Promise<void>;
}

export async function createTestD1({
  seed = false,
  migrateBefore,
}: Pick<TestPlatformOptions, "seed" | "migrateBefore"> = {}): Promise<TestD1> {
  const { env, dispose } = await createTestPlatform({ seed, migrateBefore });
  return { db: env.DB, kv: env.AUTH_KV, dispose };
}

/**
 * What the site needs besides D1: the web session KV, the R2 buckets and the checks queue
 * producer, plus the rate limiters (Miniflare's, exact within one process).
 */
export interface TestPlatformEnv {
  DB: D1Database;
  AUTH_KV: KVNamespace;
  BUNDLES: R2Bucket;
  SOURCES: R2Bucket;
  TRACES: R2Bucket;
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

/** D1 plus local KV, R2 buckets, a queue producer and rate limiters (Miniflare), nothing persisted. */
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
      kv_namespaces: [{ binding: "AUTH_KV", id: "test-auth" }],
      r2_buckets: [
        { binding: "BUNDLES", bucket_name: "test-bundles" },
        { binding: "SOURCES", bucket_name: "test-sources" },
        { binding: "TRACES", bucket_name: "test-traces" },
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

/** Every row of every table, as one string: what a D1 export would show. */
export async function dumpTables(db: D1Database) {
  const { results } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all<{ name: string }>();
  const rows: Record<string, unknown[]> = {};
  // Skips SQLite's and D1's internal tables (`_cf_*` can't be read).
  for (const { name } of results.filter((t) => !/^(sqlite|_cf)_/.test(t.name))) {
    rows[name] = (await db.prepare(`SELECT * FROM "${name}"`).all()).results;
  }
  return JSON.stringify(rows);
}
