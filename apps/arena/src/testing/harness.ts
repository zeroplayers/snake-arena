/**
 * Runs the arena worker (`testing/worker.ts`) in workerd through Miniflare, with D1 migrated from
 * apps/web, R2 and Durable Object storage persisted to a temp dir so `restart()` behaves like an
 * eviction: memory is gone, storage stays.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, type Plugin } from "esbuild";
import { Miniflare } from "miniflare";
import { unstable_splitSqlQuery as splitSqlQuery } from "wrangler";
import { bundleHouseBots, houseBundlesModule, OUTPUT } from "../../scripts/house-bundles.ts";
import type { LifeTicket } from "../protocol.ts";
import { BURN_LINE, SPIN_PREFIX } from "./burn.ts";

const appDir = join(import.meta.dirname, "../..");
const migrationsDir = join(appDir, "../web/migrations");

/** Every `.wasm` import is the QuickJS module, provided by Miniflare as a compiled module. */
const wasmPlugin: Plugin = {
  name: "wasm",
  setup(b) {
    b.onResolve({ filter: /\.wasm$/ }, () => ({ path: "./quickjs.wasm", external: true }));
  },
};

export interface HarnessOptions {
  /** Test worker entry, relative to `src/testing/`. Default `worker.ts` (the room tests'). */
  worker?: string;
  /** Classes the worker exports behind `ROOMS` and `MATCHMAKER`. */
  rooms?: string;
  matchmaker?: string;
}

export interface Harness {
  call<T = unknown>(target: "room" | "matchmaker", method: string, ...args: unknown[]): Promise<T>;
  room<T = unknown>(name: string, method: string, ...args: unknown[]): Promise<T>;
  /** Starts a call without waiting for it (it may never finish). */
  fire(name: string, method: string, ...args: unknown[]): Promise<unknown>;
  /** Restarts workerd: every object loses its memory and in-flight requests; storage stays. */
  restart(): Promise<void>;
  d1(): Promise<D1Database>;
  r2(binding?: "REPLAYS" | "BUNDLES"): Promise<R2Bucket>;
  dispose(): Promise<void>;
}

export async function createHarness({
  worker = "worker.ts",
  rooms = "RoomDO",
  matchmaker = "TestMatchmaker",
}: HarnessOptions = {}): Promise<Harness> {
  writeFileSync(OUTPUT, houseBundlesModule(await bundleHouseBots()));
  const out = await build({
    entryPoints: [join(appDir, "src/testing", worker)],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:*"],
    plugins: [wasmPlugin],
    write: false,
  });
  const wasmPath = createRequire(import.meta.url).resolve(
    "@jitl/quickjs-wasmfile-release-sync/wasm",
  );
  const dir = mkdtempSync(join(tmpdir(), "zerosnake-arena-"));
  const options = {
    resourcePersistencePath: dir,
    workers: [
      {
        config: {
          name: "arena",
          compatibilityDate: "2026-10-15",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": { type: "esm", contents: out.outputFiles[0]?.text ?? "" },
              "quickjs.wasm": { type: "wasm", contents: new Uint8Array(readFileSync(wasmPath)) },
            },
          },
          env: {
            DB: { type: "d1", id: "test" },
            REPLAYS: { type: "r2", name: "replays" },
            BUNDLES: { type: "r2", name: "bundles" },
            ROOMS: { type: "durable-object", worker: "arena", exportName: rooms },
            MATCHMAKER: { type: "durable-object", worker: "arena", exportName: matchmaker },
          },
          exports: {
            [rooms]: { type: "durable-object", storage: "sqlite" },
            [matchmaker]: { type: "durable-object", storage: "sqlite" },
          },
        },
      },
    ],
  } as unknown as ConstructorParameters<typeof Miniflare>[0];
  let mf = new Miniflare(options);
  await mf.ready;

  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const statements = splitSqlQuery(readFileSync(join(migrationsDir, file), "utf8"));
    await db.batch(statements.map((s) => db.prepare(s)));
  }

  const rpc = async (body: object) => {
    const res = await mf.dispatchFetch("http://arena/rpc", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; value?: unknown; error?: string };
    if (!json.ok) throw new Error(json.error);
    return json.value;
  };

  return {
    call: (target, method, ...args) => rpc({ target, method, args }) as never,
    room: (name, method, ...args) => rpc({ target: "room", name, method, args }) as never,
    fire: (name, method, ...args) =>
      rpc({ target: "room", name, method, args }).catch((e: unknown) => e),
    async restart() {
      await mf.dispose();
      mf = new Miniflare(options);
      await mf.ready;
    },
    d1: async () => (await mf.getD1Database("DB")) as unknown as D1Database,
    r2: async (binding = "REPLAYS") => (await mf.getR2Bucket(binding)) as unknown as R2Bucket,
    async dispose() {
      await mf.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A user, bot and ready version in D1 (lives reference versions), and a ticket for it. */
export async function seedVersion(
  db: D1Database,
  author: string,
  source: string,
  lifeId = `life-${author}-1`,
): Promise<LifeTicket> {
  const versionId = `v-${author}`;
  await db.batch([
    db
      .prepare("INSERT OR IGNORE INTO users (id, name, email) VALUES (?, ?, ?)")
      .bind(author, author, `${author}@example.com`),
    db
      .prepare("INSERT OR IGNORE INTO bots (id, owner_id, name, slug) VALUES (?, ?, ?, ?)")
      .bind(`bot-${author}`, author, author, author),
    db
      .prepare(
        `INSERT OR IGNORE INTO versions (id, bot_id, n, status, bundle_key, source_key)
         VALUES (?, ?, 1, 'ready', 'b', 's')`,
      )
      .bind(versionId, `bot-${author}`),
  ]);
  return { lifeId, versionId, author, source };
}

const BURN = JSON.stringify(BURN_LINE);

/** Bots written as plain JS modules (they run in the sandbox as-is). */
export const BOTS = {
  /** Throws every tick: dies by `error` on its third tick. */
  thrower: `export default { tick() { throw new Error("boom"); } };`,
  /** Goes straight, then circles. */
  circler: `export default { tick(state) { return { turn: state.lifeTick > 20 ? 0.3 : 0 }; } };`,
  /**
   * At life tick `at`, burns CPU forever inside its tick (the test sandbox spins on `BURN`,
   * standing in for an operation the meter can't charge). Only the DO's CPU limit (here: a
   * restart) stops it.
   */
  hostile: (at: number) => `
    export default { tick(state) {
      if (state.lifeTick === ${at}) console.log(${BURN});
      return { turn: 1 };
    } };`,
  /**
   * Burns forever once its sandbox life has seen more than `after` ticks: a restart (which resets
   * memory) puts it off, so only running forward under watch catches it.
   */
  burnAfter: (after: number) => `
    export default {
      init() { return { seen: 0 }; },
      tick(state, mem) {
        if (++mem.seen > ${after}) console.log(${BURN});
        return { turn: 1 };
      },
    };`,
  /**
   * Burns forever once the snakes it sees turned on two ticks in a row: it depends on its
   * neighbours, so only running it with the room's real neighbours reproduces it.
   */
  neighbours: `
    export default {
      init() { return { angles: {}, turning: 0 }; },
      tick(state, mem) {
        const angles = {};
        let turned = false;
        for (const s of state.snakes) {
          if (s.angle === null) continue;
          angles[s.id] = s.angle;
          if (s.id in mem.angles && mem.angles[s.id] !== s.angle) turned = true;
        }
        mem.angles = angles;
        mem.turning = turned ? mem.turning + 1 : 0;
        if (mem.turning >= 2) console.log(${BURN});
        return { turn: 0 };
      },
    };`,
  /**
   * One of `of` colluders: burns forever once its sandbox life has seen more than `after` ticks,
   * but only on room ticks whose residue mod `of` is `turn`. Restarts put it off (memory resets),
   * and which colluder a kill names depends on the frame the room restarted from.
   */
  turns: (turn: number, of: number, after: number) => `
    export default {
      init() { return { seen: 0 }; },
      tick(state, mem) {
        if (++mem.seen > ${after} && state.tick % ${of} === ${turn}) console.log(${BURN});
        return { turn: 1 };
      },
    };`,
  /** Honest about its result but slow every tick: the host is kept busy ~`ms` per tick. */
  slow: (ms: number) => `
    export default { tick(state) {
      console.log(${JSON.stringify(SPIN_PREFIX)} + ${ms});
      return { turn: 1 };
    } };`,
};
