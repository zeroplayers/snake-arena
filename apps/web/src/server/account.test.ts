import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../db";
import { getLeaderboard, getProfile } from "../db/queries";
import { readVersionSources } from "../queries/sources";
import { ACCOUNT_PURGE_AFTER_MS, type ActiveVersionChange, DELETED_USER_NAME } from "../shared";
import { signUp, type TestAccount, webSessions } from "../test/accounts";
import { createTestPlatform, dumpTables, type TestPlatformEnv } from "../test/d1";
import {
  ACCOUNT_EXPORT_FORMAT,
  createAccount,
  deleteUnclaimedAccounts,
  PURGE_MAX_FAILURES,
  pruneExpiredCredentials,
  purgeDeletedAccounts,
} from "./account";
import { type Auth, createAuth } from "./auth";
import { hashToken } from "./cli-auth";

const BASE = "http://localhost:3000";

let env: TestPlatformEnv;
let dispose: () => Promise<void>;
let auth: Auth;
let notified: ActiveVersionChange[];
let clock: Date;

beforeEach(async () => {
  ({ env, dispose } = await createTestPlatform());
  auth = createAuth({
    DB: env.DB,
    AUTH_KV: env.AUTH_KV,
    BETTER_AUTH_URL: BASE,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    GITHUB_CLIENT_ID: "test-client-id",
    GITHUB_CLIENT_SECRET: "test-client-secret",
  });
  notified = [];
  clock = new Date("2026-10-27T12:00:00Z");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await dispose();
});

function account() {
  return createAccount(
    { ...env, BETTER_AUTH_URL: BASE },
    {
      getSession: (input) => auth.api.getSession(input),
      notify: async (change) => {
        notified.push(change);
      },
      now: () => clock,
    },
  );
}

function req(
  who: TestAccount | null,
  path: string,
  {
    method = "GET",
    body,
    origin = BASE,
  }: { method?: string; body?: unknown; origin?: string | null } = {},
) {
  const headers = new Headers();
  if (who) headers.set("cookie", who.jar.header());
  if (origin) headers.set("origin", origin);
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request(`${BASE}${path}`, {
    method,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

const deleteRequest = (who: TestAccount, confirm: string, origin: string | null = BASE) =>
  req(who, "/api/account/delete", { method: "POST", body: { confirm }, origin });

const session = (who: TestAccount) =>
  auth.api.getSession({ headers: new Headers({ cookie: who.jar.header() }) });

/** A bot with a `ready` and an `archived` version, their R2 objects and `lives` finished lives each. */
async function seedBot(owner: string, slug: string, lives = 3) {
  const db = env.DB;
  const botId = `${slug}-bot`;
  const statements = [
    db
      .prepare("INSERT INTO bots (id, owner_id, name, slug) VALUES (?, ?, ?, ?)")
      .bind(botId, owner, slug, slug),
  ];
  const versionIds: string[] = [];
  for (const n of [1, 2]) {
    const id = `${slug}-v${n}`;
    versionIds.push(id);
    statements.push(
      db
        .prepare(
          `INSERT INTO versions (id, bot_id, n, status, bundle_key, source_key, activated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0)`,
        )
        .bind(
          id,
          botId,
          n,
          n === 2 ? "ready" : "archived",
          `bundles/${id}.js`,
          `sources/${id}.json`,
        ),
    );
    for (let i = 0; i < lives; i++) {
      statements.push(
        db
          .prepare(
            `INSERT INTO lives (id, version_id, room, start_tick, end_tick, score, death_cause,
               replay_key, trace_key, started_at, ended_at)
             VALUES (?, ?, 'room-1', ?, ?, ?, 'wall', 'room-1/0.zsr', ?, ?, ?)`,
          )
          .bind(
            `${id}-life${i}`,
            id,
            i * 100,
            i * 100 + 50,
            10 + i,
            `2026-10-27/${id}-life${i}`,
            clock.getTime() - 60_000,
            clock.getTime(),
          ),
      );
    }
  }
  statements.push(
    db
      .prepare(
        "INSERT INTO ratings (version_id, mean, ci, n_lives, alive_ticks, activated_at) VALUES (?, 20, 2, 40, 36000, 0)",
      )
      .bind(`${slug}-v2`),
  );
  await db.batch(statements);
  for (const id of versionIds) {
    await env.BUNDLES.put(`bundles/${id}.js`, `export default "${id}";`);
    await env.SOURCES.put(
      `sources/${id}.json`,
      JSON.stringify({ format: "zerosnake-sources@1", files: [] }),
    );
    for (let i = 0; i < lives; i++) await env.TRACES.put(`2026-10-27/${id}-life${i}`, "trace");
  }
  return { botId, versionIds };
}

async function addCliToken(userId: string, token = "zsk_secret_token") {
  await env.DB.prepare(
    `INSERT INTO cli_tokens (id, user_id, token_hash, user_agent, ip_address, expires_at)
     VALUES (?, ?, ?, 'zerosnake/1.0', '192.0.2.1', ?)`,
  )
    .bind(`tok-${userId}`, userId, await hashToken(token), Date.now() + 86_400_000)
    .run();
}

const count = async (sql: string, ...args: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...args)
      .first<{ n: number }>()
  )?.n ?? 0;

describe("Download my data", () => {
  it("exports the user's rows as one JSON file, with no secrets", async () => {
    const ada = await signUp(auth, env.DB, BASE, "ada", 1);
    const bob = await signUp(auth, env.DB, BASE, "bob", 2);
    await seedBot(ada.id, "viper");
    await seedBot(bob.id, "cobra");
    await addCliToken(ada.id);
    await env.DB.prepare(
      "UPDATE lives SET replay_expired_at = 1 WHERE id = 'viper-v1-life1'",
    ).run();

    const response = await account().exportData(req(ada, "/api/account/export"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="zerosnake-ada-2026-10-27.json"',
    );
    const text = await response.text();
    const data = JSON.parse(text);
    expect(data).toMatchObject({
      format: ACCOUNT_EXPORT_FORMAT,
      profile: { id: ada.id, username: "ada", email: "ada@example.com", githubLogin: "ada" },
      linkedAccounts: [{ provider: "github", accountId: "1" }],
      cliTokens: [{ userAgent: "zerosnake/1.0", ipAddress: "192.0.2.1" }],
    });
    expect(data.webSessions).toHaveLength(1);
    expect(data.bots).toHaveLength(1);
    const [bot] = data.bots;
    expect(bot).toMatchObject({ slug: "viper", url: `${BASE}/@ada/viper` });
    expect(bot.versions.map((v: { n: number }) => v.n)).toEqual([1, 2]);
    expect(bot.versions[1]).toMatchObject({
      status: "ready",
      rating: { mean: 20, ci: 2, nLives: 40 },
      files: {
        bundle: `${BASE}/api/account/files/viper-v2/bundle`,
        source: `${BASE}/api/account/files/viper-v2/source`,
      },
    });
    expect(data.lives).toHaveLength(6);
    expect(data.lives[0]).toMatchObject({
      versionId: "viper-v1",
      score: 10,
      replay: `${BASE}/replay/viper-v1-life0`,
      traceKept: true,
    });
    expect(data.lives[1]).toMatchObject({ id: "viper-v1-life1", replay: null });
    // Only ada's: none of bob's rows, and no token, hash or storage key.
    expect(text).not.toContain("cobra");
    expect(text).not.toContain(await hashToken("zsk_secret_token"));
    for (const { token } of await webSessions(env.AUTH_KV)) expect(text).not.toContain(token);
    expect(text).not.toContain("bundles/");
    expect(text).not.toMatch(/accessToken|access_token|sessionsRevokedAt/);
  });

  it("pages through many lives", async () => {
    const ada = await signUp(auth, env.DB, BASE, "ada", 1);
    await seedBot(ada.id, "viper", 0);
    // 2500 finished lives (more than two export pages) and one without an end.
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 2499)
       INSERT INTO lives (id, version_id, room, start_tick, end_tick, score)
       SELECT 'many-' || i, 'viper-v2', 'room-1', i, i + 1, i FROM n`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO lives (id, version_id, room, start_tick) VALUES ('open', 'viper-v1', 'room-1', 0)`,
    ).run();
    const response = await account().exportData(req(ada, "/api/account/export"));
    const data = (await response.json()) as { lives: { id: string }[] };
    expect(data.lives).toHaveLength(2501);
    expect(new Set(data.lives.map((l) => l.id)).size).toBe(2501);
  }, 60_000);

  it("needs a web session", async () => {
    const response = await account().exportData(req(null, "/api/account/export"));
    expect(response.status).toBe(401);
  });

  it("serves a version's bundle and sources to its owner only", async () => {
    const ada = await signUp(auth, env.DB, BASE, "ada", 1);
    const bob = await signUp(auth, env.DB, BASE, "bob", 2);
    await seedBot(ada.id, "viper");
    const bundle = await account().file(req(ada, "/x"), "viper-v2", "bundle");
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("content-disposition")).toBe('attachment; filename="viper-v2.js"');
    expect(await bundle.text()).toBe('export default "viper-v2";');
    const source = await account().file(req(ada, "/x"), "viper-v1", "source");
    expect(JSON.parse(await source.text())).toMatchObject({ format: "zerosnake-sources@1" });
    expect((await account().file(req(bob, "/x"), "viper-v2", "bundle")).status).toBe(404);
    expect((await account().file(req(ada, "/x"), "viper-v2", "secrets")).status).toBe(400);
  });
});

describe("Delete my account", () => {
  it("needs the username typed and the site's own origin", async () => {
    const ada = await signUp(auth, env.DB, BASE, "ada", 1);
    const wrong = await account().deleteAccount(deleteRequest(ada, "bob"));
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: "confirmation_mismatch" });
    const foreign = await account().deleteAccount(deleteRequest(ada, "ada", "https://evil.test"));
    expect(foreign.status).toBe(403);
    expect(await session(ada)).not.toBeNull();
    expect(await count("SELECT count(*) AS n FROM users WHERE deleted_at IS NOT NULL")).toBe(0);
  });

  it("scrubs the profile, signs out everywhere and stops the bots at once", async () => {
    const ada = await signUp(auth, env.DB, BASE, "ada", 1);
    const bob = await signUp(auth, env.DB, BASE, "bob", 2);
    await seedBot(ada.id, "viper");
    await seedBot(bob.id, "cobra");
    await addCliToken(ada.id);
    await env.DB.prepare(
      `INSERT INTO versions (id, bot_id, n, status, bundle_key, source_key)
       VALUES ('viper-v3', 'viper-bot', 3, 'validating', 'b3', 's3')`,
    ).run();

    const response = await account().deleteAccount(deleteRequest(ada, " Ada "));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/^better-auth\.session_token=; Max-Age=0/);

    // Signed out: the web session reads as missing, the CLI token is gone.
    expect(await session(ada)).toBeNull();
    expect(await session(bob)).not.toBeNull();
    expect((await webSessions(env.AUTH_KV)).map((s) => s.userId)).toEqual([bob.id]);
    expect(await count("SELECT count(*) AS n FROM cli_tokens WHERE user_id = ?", ada.id)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM accounts WHERE user_id = ?", ada.id)).toBe(0);

    // A tombstone with nothing personal left in the database.
    const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(ada.id).first();
    expect(user).toMatchObject({
      name: DELETED_USER_NAME,
      email: `deleted-${ada.id}@deleted.invalid`,
      username: null,
      github_login: null,
      image: null,
      deleted_at: clock.getTime(),
    });
    const dump = await dumpTables(env.DB);
    expect(dump).not.toContain("ada@example.com");
    expect(dump).not.toMatch(/"ada"/);

    // The bots stopped: nothing `ready` or in checks, the matchmaker told, off every page.
    const statuses = await env.DB.prepare(
      "SELECT id, status FROM versions WHERE bot_id = 'viper-bot' ORDER BY n",
    ).all();
    expect(statuses.results).toEqual([
      { id: "viper-v1", status: "archived" },
      { id: "viper-v2", status: "archived" },
      { id: "viper-v3", status: "rejected" },
    ]);
    expect(
      await count(
        "SELECT count(*) AS n FROM bots WHERE owner_id = ? AND archived_at IS NULL",
        ada.id,
      ),
    ).toBe(0);
    expect(notified).toEqual([
      expect.objectContaining({
        botId: "viper-bot",
        previousVersionId: "viper-v2",
        versionId: null,
      }),
    ]);
    const db = createDb(env.DB);
    expect(await getProfile(db, "ada")).toBeNull();
    expect((await getLeaderboard(db)).map((r) => r.botSlug)).toEqual(["cobra"]);
    // Their sources aren't served by version id either; a banned author's aren't.
    await env.SOURCES.put(
      "sources/cobra-v2.json",
      JSON.stringify({ format: "zerosnake-sources@1", files: [] }),
    );
    expect(await readVersionSources(db, env.SOURCES, "viper-v2")).toBeNull();
    expect(await readVersionSources(db, env.SOURCES, "cobra-v2")).toMatchObject({ status: "ok" });
    await env.DB.prepare("UPDATE users SET banned_at = 1 WHERE id = ?").bind(bob.id).run();
    expect(await readVersionSources(db, env.SOURCES, "cobra-v2")).toBeNull();
  });

  it("lets the same GitHub account sign up again as a new user", async () => {
    const ada = await signUp(auth, env.DB, BASE, "ada", 1);
    await account().deleteAccount(deleteRequest(ada, "ada"));
    const again = await signUp(auth, env.DB, BASE, "ada-again", 1);
    expect(again.id).not.toBe(ada.id);
    expect(await session(again)).not.toBeNull();
  });

  it("holds the username for 30 days", async () => {
    const ada = await signUp(auth, env.DB, BASE, "ada", 1);
    await account().deleteAccount(deleteRequest(ada, "ada"));
    const claim = async (who: TestAccount, username: string) =>
      auth.handler(
        new Request(`${BASE}/api/auth/username/claim`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE, cookie: who.jar.header() },
          body: JSON.stringify({ username }),
        }),
      );
    const eve = await signUp(auth, env.DB, BASE, "eve", 5);
    // eve already has a username; a fresh account tries to claim "ada".
    await env.DB.prepare("UPDATE users SET username = NULL WHERE id = ?").bind(eve.id).run();
    const taken = await claim(eve, "ADA");
    expect(taken.status).toBe(400);
    expect(await taken.json()).toMatchObject({ code: "USERNAME_IS_ALREADY_TAKEN" });
    // The hold ends; the prune forgets it.
    await env.DB.prepare("UPDATE held_usernames SET until = 1").run();
    await pruneExpiredCredentials(env.DB, new Date());
    expect(await count("SELECT count(*) AS n FROM held_usernames")).toBe(0);
    expect((await claim(eve, "ada")).status).toBe(200);
  });

  it("works before a username is chosen, confirmed with a word", async () => {
    const ada = await signUp(auth, env.DB, BASE, "ada", 1);
    await env.DB.prepare("UPDATE users SET username = NULL WHERE id = ?").bind(ada.id).run();
    const data = await (await account().exportData(req(ada, "/api/account/export"))).json();
    expect(data).toMatchObject({
      profile: { username: null, email: "ada@example.com" },
      complete: true,
    });
    expect((await account().deleteAccount(deleteRequest(ada, "ada"))).status).toBe(400);
    expect((await account().deleteAccount(deleteRequest(ada, "delete"))).status).toBe(200);
    expect(await session(ada)).toBeNull();
    expect(await count("SELECT count(*) AS n FROM held_usernames")).toBe(0);
  });

  it("deletes accounts that never chose a username after 30 days", async () => {
    const ada = await signUp(auth, env.DB, BASE, "ada", 1);
    const bob = await signUp(auth, env.DB, BASE, "bob", 2);
    await env.DB.prepare("UPDATE users SET username = NULL, created_at = 0").run();
    await env.DB.prepare("UPDATE users SET username = 'bob' WHERE id = ?").bind(bob.id).run();
    expect(await deleteUnclaimedAccounts(env.DB, new Date())).toBe(1);
    const row = await env.DB.prepare("SELECT deleted_at, email FROM users WHERE id = ?")
      .bind(ada.id)
      .first<{ deleted_at: number | null; email: string }>();
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.email).toBe(`deleted-${ada.id}@deleted.invalid`);
    expect(await session(bob)).not.toBeNull();
    expect(await deleteUnclaimedAccounts(env.DB, new Date())).toBe(0);
  });
});

describe("purgeDeletedAccounts", () => {
  it("erases the rest after the grace period, and keeps other players' lives", async () => {
    const ada = await signUp(auth, env.DB, BASE, "ada", 1);
    const bob = await signUp(auth, env.DB, BASE, "bob", 2);
    await seedBot(ada.id, "viper");
    await seedBot(bob.id, "cobra");
    // One of bob's lives was ended by ada's bot.
    await env.DB.prepare("UPDATE lives SET killer = 'viper-v2' WHERE id = 'cobra-v2-life0'").run();
    // Bob deployed the same code as ada's v2 (content-addressed: same R2 objects).
    await env.DB.prepare(
      `INSERT INTO versions (id, bot_id, n, status, bundle_key, source_key)
       VALUES ('cobra-v3', 'cobra-bot', 3, 'archived', 'bundles/viper-v2.js', 'sources/viper-v2.json')`,
    ).run();
    await account().deleteAccount(deleteRequest(ada, "ada"));

    const early = new Date(clock.getTime() + ACCOUNT_PURGE_AFTER_MS - 1);
    expect(await purgeDeletedAccounts(env, early)).toMatchObject({ users: 0, lives: 0 });

    const later = new Date(clock.getTime() + ACCOUNT_PURGE_AFTER_MS);
    // A small budget takes several runs.
    const budget = { users: 5, livesPage: 2, versionsPage: 1, subrequests: 30 };
    const runs = [];
    for (let i = 0; i < 10; i++) {
      const run = await purgeDeletedAccounts(env, later, budget);
      runs.push(run);
      if (!run.more) break;
    }
    expect(runs.length).toBeGreaterThan(1);
    expect(runs.reduce((n, r) => n + r.lives, 0)).toBe(6);
    expect(runs.reduce((n, r) => n + r.versions, 0)).toBe(2);
    expect(runs.at(-1)).toMatchObject({ users: 1, more: false, failed: 0 });
    for (const run of runs) expect(run.subrequests).toBeLessThanOrEqual(budget.subrequests);

    expect(await count("SELECT count(*) AS n FROM users WHERE id = ?", ada.id)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM bots WHERE owner_id = ?", ada.id)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM versions WHERE id LIKE 'viper-%'")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM lives WHERE id LIKE 'viper-%'")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM ratings WHERE version_id LIKE 'viper-%'")).toBe(
      0,
    );
    const keys = async (bucket: R2Bucket) =>
      (await bucket.list()).objects.map((o) => o.key).filter((k) => k.includes("viper"));
    // Only the objects bob's version shares are left.
    expect(await keys(env.BUNDLES)).toEqual(["bundles/viper-v2.js"]);
    expect(await keys(env.SOURCES)).toEqual(["sources/viper-v2.json"]);
    expect(await keys(env.TRACES)).toEqual([]);
    expect(await env.BUNDLES.get("bundles/cobra-v1.js")).not.toBeNull();
    // Bob's life is still there; its killer now resolves to nothing.
    expect(await count("SELECT count(*) AS n FROM lives WHERE id LIKE 'cobra-%'")).toBe(6);
    expect(await count("SELECT count(*) AS n FROM versions WHERE id LIKE 'cobra-%'")).toBe(3);
    const life = await env.DB.prepare(
      "SELECT killer FROM lives WHERE id = 'cobra-v2-life0'",
    ).first();
    expect(life).toEqual({ killer: "viper-v2" });
    expect(await purgeDeletedAccounts(env, later)).toMatchObject({ users: 0, more: false });
  });

  it("puts a shared object back when an identical deploy lands mid-delete", async () => {
    const ada = await signUp(auth, env.DB, BASE, "ada", 1);
    const bob = await signUp(auth, env.DB, BASE, "bob", 2);
    await seedBot(ada.id, "viper", 0);
    await seedBot(bob.id, "cobra", 0);
    await account().deleteAccount(deleteRequest(ada, "ada"));
    // Bob's deploy of the same bundle writes its row right after the purge checked the key.
    const bundles: R2Bucket = Object.create(env.BUNDLES);
    bundles.delete = async (keys) => {
      await env.BUNDLES.delete(keys);
      if ([keys].flat().includes("bundles/viper-v2.js")) {
        await env.DB.prepare(
          `INSERT INTO versions (id, bot_id, n, status, bundle_key, source_key)
           VALUES ('cobra-v3', 'cobra-bot', 3, 'validating', 'bundles/viper-v2.js', 's')`,
        ).run();
      }
    };
    const later = new Date(clock.getTime() + ACCOUNT_PURGE_AFTER_MS);
    await purgeDeletedAccounts({ ...env, BUNDLES: bundles }, later);
    expect(await (await env.BUNDLES.get("bundles/viper-v2.js"))?.text()).toBe(
      'export default "viper-v2";',
    );
    expect(await env.BUNDLES.get("bundles/viper-v1.js")).toBeNull();
    expect(await count("SELECT count(*) AS n FROM users WHERE id = ?", ada.id)).toBe(0);
  });
});

describe("purgeDeletedAccounts at scale", () => {
  it("purges a big account over several runs, within the subrequest budget", async () => {
    const ada = await signUp(auth, env.DB, BASE, "ada", 1);
    await env.DB.prepare(
      "INSERT INTO bots (id, owner_id, name, slug) VALUES ('big-bot', ?, 'big', 'big')",
    )
      .bind(ada.id)
      .run();
    // 300 versions with their own keys, and 3000 lives with traces.
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
       INSERT INTO versions (id, bot_id, n, status, bundle_key, source_key)
       SELECT 'big-v' || i, 'big-bot', i, 'archived', 'big/' || i || '.js', 'big/' || i || '.json'
       FROM n`,
    ).run();
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 2999)
       INSERT INTO lives (id, version_id, room, start_tick, end_tick, trace_key)
       SELECT 'big-l' || i, 'big-v' || (i % 300 + 1), 'r', i, i + 1, 't/' || i FROM n`,
    ).run();
    for (let i = 1; i <= 300; i += 50) {
      await Promise.all(
        Array.from({ length: 50 }, (_, j) => env.BUNDLES.put(`big/${i + j}.js`, "x")),
      );
    }
    await account().deleteAccount(deleteRequest(ada, "ada"));
    const later = new Date(clock.getTime() + ACCOUNT_PURGE_AFTER_MS);
    const budget = { users: 5, livesPage: 500, versionsPage: 25, subrequests: 200 };
    let runs = 0;
    for (; runs < 30; runs++) {
      const run = await purgeDeletedAccounts(env, later, budget);
      expect(run.subrequests).toBeLessThanOrEqual(budget.subrequests);
      expect(run.failed).toBe(0);
      if (!run.more) break;
    }
    expect(runs).toBeGreaterThan(1);
    expect(runs).toBeLessThan(30);
    expect(await count("SELECT count(*) AS n FROM users WHERE id = ?", ada.id)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM lives WHERE id LIKE 'big-%'")).toBe(0);
    expect((await env.BUNDLES.list({ prefix: "big/" })).objects).toEqual([]);
  }, 120_000);

  it("a tombstone that keeps failing doesn't hold up the others", async () => {
    const ada = await signUp(auth, env.DB, BASE, "ada", 1);
    const bob = await signUp(auth, env.DB, BASE, "bob", 2);
    await seedBot(ada.id, "viper", 1);
    await seedBot(bob.id, "cobra", 1);
    await account().deleteAccount(deleteRequest(ada, "ada"));
    clock = new Date(clock.getTime() + 1000);
    await account().deleteAccount(deleteRequest(bob, "bob"));
    // Deleting ada's traces fails every time; bob's go through.
    const traces: R2Bucket = Object.create(env.TRACES);
    traces.delete = async (keys) => {
      if ([keys].flat().some((k) => k.includes("viper"))) throw new Error("R2 is down for ada");
      await env.TRACES.delete(keys);
    };
    const later = new Date(clock.getTime() + ACCOUNT_PURGE_AFTER_MS);
    const first = await purgeDeletedAccounts({ ...env, TRACES: traces }, later);
    expect(first).toMatchObject({ users: 1, failed: 1, more: true });
    expect(await count("SELECT count(*) AS n FROM users WHERE id = ?", bob.id)).toBe(0);
    for (let i = 1; i < PURGE_MAX_FAILURES; i++) {
      await purgeDeletedAccounts({ ...env, TRACES: traces }, later);
    }
    const failures = await env.DB.prepare("SELECT purge_failures AS n FROM users WHERE id = ?")
      .bind(ada.id)
      .first<{ n: number }>();
    expect(failures?.n).toBe(PURGE_MAX_FAILURES);
    // Left for a person: no longer picked up.
    expect(await purgeDeletedAccounts({ ...env, TRACES: traces }, later)).toMatchObject({
      failed: 0,
      more: false,
    });
  });
});

describe("purgeDeletedAccounts edge cases", () => {
  it("leaves alone a key that was missing at the read and lands for someone else", async () => {
    const ada = await signUp(auth, env.DB, BASE, "ada", 1);
    const bob = await signUp(auth, env.DB, BASE, "bob", 2);
    await seedBot(ada.id, "viper", 0);
    await seedBot(bob.id, "cobra", 0);
    // An earlier, interrupted run already deleted ada's v2 bundle.
    await env.BUNDLES.delete("bundles/viper-v2.js");
    await account().deleteAccount(deleteRequest(ada, "ada"));
    // Right after the purge finds it missing, bob deploys the same bundle (row, then object).
    const bundles: R2Bucket = Object.create(env.BUNDLES);
    bundles.get = (async (key: string) => {
      const object = await env.BUNDLES.get(key);
      if (key === "bundles/viper-v2.js") {
        await env.DB.prepare(
          `INSERT INTO versions (id, bot_id, n, status, bundle_key, source_key)
           VALUES ('cobra-v3', 'cobra-bot', 3, 'validating', 'bundles/viper-v2.js', 's')`,
        ).run();
        await env.BUNDLES.put(key, "bob's bundle");
      }
      return object;
    }) as R2Bucket["get"];
    const later = new Date(clock.getTime() + ACCOUNT_PURGE_AFTER_MS);
    await purgeDeletedAccounts({ ...env, BUNDLES: bundles }, later);
    expect(await (await env.BUNDLES.get("bundles/viper-v2.js"))?.text()).toBe("bob's bundle");
    expect(await env.BUNDLES.get("bundles/viper-v1.js")).toBeNull();
  });

  it("counts every call, failed ones too, and stays within the budget", async () => {
    const names = ["a1", "a2", "a3", "a4", "a5", "a6"];
    for (const [i, name] of names.entries()) {
      const who = await signUp(auth, env.DB, BASE, name, 10 + i);
      await seedBot(who.id, `bot${name}`, 2);
      await account().deleteAccount(deleteRequest(who, name));
    }
    // Every trace delete fails, after the calls before it went out.
    let real = 0;
    const count = <T extends object>(target: T, methods: (keyof T)[]): T => {
      const wrapped: T = Object.create(target);
      for (const m of methods) {
        const fn = target[m] as (...args: unknown[]) => unknown;
        (wrapped[m] as unknown) = (...args: unknown[]) => {
          real++;
          return fn.apply(target, args);
        };
      }
      return wrapped;
    };
    const traces = count(env.TRACES, ["get", "put"]);
    traces.delete = async () => {
      real++;
      throw new Error("R2 is down");
    };
    const db = count(env.DB, ["prepare"]);
    const budget = { users: 6, livesPage: 500, versionsPage: 2, subrequests: 50 };
    const later = new Date(clock.getTime() + ACCOUNT_PURGE_AFTER_MS);
    const run = await purgeDeletedAccounts(
      {
        DB: db,
        TRACES: traces,
        BUNDLES: count(env.BUNDLES, ["get", "put", "delete"]),
        SOURCES: count(env.SOURCES, ["get", "put", "delete"]),
      },
      later,
      budget,
    );
    expect(run.failed).toBeGreaterThan(0);
    expect(run.subrequests).toBe(real);
    expect(real).toBeLessThanOrEqual(budget.subrequests);
  });

  it("counts only failures in a row", async () => {
    const ada = await signUp(auth, env.DB, BASE, "ada", 1);
    await seedBot(ada.id, "viper", 3);
    await account().deleteAccount(deleteRequest(ada, "ada"));
    const failures = async () =>
      (
        await env.DB.prepare("SELECT purge_failures AS n FROM users WHERE id = ?")
          .bind(ada.id)
          .first<{ n: number }>()
      )?.n;
    const broken: R2Bucket = Object.create(env.TRACES);
    broken.delete = async () => {
      throw new Error("R2 is down");
    };
    const later = new Date(clock.getTime() + ACCOUNT_PURGE_AFTER_MS);
    await purgeDeletedAccounts({ ...env, TRACES: broken }, later);
    await purgeDeletedAccounts({ ...env, TRACES: broken }, later);
    expect(await failures()).toBe(2);
    // One page goes through (the budget stops the run there): the count starts over.
    const budget = { users: 5, livesPage: 2, versionsPage: 2, subrequests: 20 };
    expect(await purgeDeletedAccounts(env, later, budget)).toMatchObject({ more: true });
    expect(await failures()).toBe(0);
  });
});

describe("pruneExpiredCredentials", () => {
  it("deletes expired CLI tokens, and device codes and sign-in state an hour after expiry", async () => {
    const ada = await signUp(auth, env.DB, BASE, "ada", 1);
    const now = Date.now();
    const hour = 60 * 60_000;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO cli_tokens (id, user_id, token_hash, expires_at) VALUES
           ('live', ?1, 'h1', ?2), ('expired', ?1, 'h2', ?3)`,
      ).bind(ada.id, now + hour, now - 1),
      env.DB.prepare(
        `INSERT INTO device_codes (id, device_code, user_code, expires_at, status) VALUES
           ('recent', 'd1', 'U1', ?1, 'pending'), ('old', 'd2', 'U2', ?2, 'pending')`,
      ).bind(now - hour + 1000, now - hour - 1000),
      env.DB.prepare(
        `INSERT INTO verifications (id, identifier, value, expires_at) VALUES
           ('v-recent', 'a', 'x', ?1), ('v-old', 'b', 'y', ?2)`,
      ).bind(now - 1000, now - 2 * hour),
    ]);
    await pruneExpiredCredentials(env.DB, new Date(now));
    const ids = async (table: string) =>
      (await env.DB.prepare(`SELECT id FROM ${table} ORDER BY id`).all<{ id: string }>()).results
        .map((r) => r.id)
        .filter((id) => ["live", "expired", "recent", "old", "v-recent", "v-old"].includes(id));
    expect(await ids("cli_tokens")).toEqual(["live"]);
    expect(await ids("device_codes")).toEqual(["recent"]);
    expect(await ids("verifications")).toEqual(["v-recent"]);
  });
});
