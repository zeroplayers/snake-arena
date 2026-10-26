/**
 * Real D1 (workerd, via wrangler's platform proxy) for tests, migrated with the same SQL files
 * `wrangler d1 migrations apply` uses. Nothing is persisted.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, unstable_splitSqlQuery as splitSqlQuery } from "wrangler";

const appDir = join(import.meta.dirname, "../..");
export const migrationsDir = join(appDir, "migrations");
export const seedFile = join(appDir, "seed/dev.sql");

export interface TestD1 {
  db: D1Database;
  dispose(): Promise<void>;
}

export async function createTestD1({ seed = false } = {}): Promise<TestD1> {
  // A config with nothing but the database, so the proxy doesn't look for apps/arena.
  const dir = mkdtempSync(join(tmpdir(), "zerosnake-d1-"));
  const configPath = join(dir, "wrangler.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "zerosnake-web-test",
      compatibility_date: "2026-10-15",
      d1_databases: [{ binding: "DB", database_name: "test", database_id: "test" }],
    }),
  );
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath,
    persist: false,
    envFiles: [],
    remoteBindings: false,
  });
  const db = proxy.env.DB;
  await applyMigrations(db);
  if (seed) await execFile(db, seedFile);
  return {
    db,
    dispose: async () => {
      await proxy.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function applyMigrations(db: D1Database) {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) await execFile(db, join(migrationsDir, file));
}

/** Runs a SQL file the way `wrangler d1 execute --file` does. */
export async function execFile(db: D1Database, path: string) {
  const statements = splitSqlQuery(readFileSync(path, "utf8"));
  await db.batch(statements.map((s) => db.prepare(s)));
}
