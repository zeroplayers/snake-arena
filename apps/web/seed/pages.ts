/**
 * `pnpm db:seed` runs this after `dev.sql`: writes `pages-data.ts` (a recorded replay, its lives,
 * every seed version's sources) to the local D1 and R2 that `pnpm dev` uses.
 *
 * Goes through wrangler's platform proxy with the same database id and bucket names as
 * `wrangler.jsonc`, persisted where `vite.config.ts` keeps local state.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy } from "wrangler";
import { buildPagesSeed } from "./pages-data.ts";

const state = join(import.meta.dirname, "../../../.wrangler/state/v3");
const dir = mkdtempSync(join(tmpdir(), "zerosnake-seed-"));
const configPath = join(dir, "wrangler.json");
writeFileSync(
  configPath,
  JSON.stringify({
    name: "zerosnake-web-seed",
    compatibility_date: "2026-10-15",
    d1_databases: [{ binding: "DB", database_name: "zerosnake-dev", database_id: "zerosnake-dev" }],
    r2_buckets: [
      { binding: "SOURCES", bucket_name: "zerosnake-dev-sources" },
      { binding: "REPLAYS", bucket_name: "zerosnake-dev-replays" },
    ],
  }),
);

const proxy = await getPlatformProxy<{ DB: D1Database; SOURCES: R2Bucket; REPLAYS: R2Bucket }>({
  configPath,
  persist: { path: state },
  envFiles: [],
  remoteBindings: false,
});
try {
  const seed = buildPagesSeed();
  const { env } = proxy;
  await env.DB.batch(seed.statements.map((s) => env.DB.prepare(s)));
  for (const o of seed.objects) {
    await env[o.bucket].put(o.key, o.body, { httpMetadata: { contentType: o.contentType } });
  }
  console.log(`pages seed: ${seed.statements.length} statements, ${seed.objects.length} objects`);
} finally {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
}
