import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../db";
import { getLeaderboard, getProfile } from "../db/queries";
import { ACCOUNT_PURGE_AFTER_MS, type ActiveVersionChange, DELETED_USER_NAME } from "../shared";
import { signUp, type TestAccount, webSessions } from "../test/accounts";
import { createTestPlatform, dumpTables, type TestPlatformEnv } from "../test/d1";
import {
  ACCOUNT_EXPORT_FORMAT,
  createAccount,
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
             VALUES (?, ?, 'room-1', ?, ?, ?, 'wall', 'room-1/0.zsr', ?, 0, 1)`,
          )
          .bind(`${id}-life${i}`, id, i * 100, i * 100 + 50, 10 + i, `2026-10-27/${id}-life${i}`),
      );
    }
  }
  statements.push(
    db
      .prepare(
        "INSERT INTO ratings (version_id, mean, ci, n_lives, activated_at) VALUES (?, 20, 2, 40, 0)",
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
  });

  it("lets the same GitHub account sign up again as a new user", async () => {
    const ada = await signUp(auth, env.DB, BASE, "ada", 1);
    await account().deleteAccount(deleteRequest(ada, "ada"));
    const again = await signUp(auth, env.DB, BASE, "ada", 1);
    expect(again.id).not.toBe(ada.id);
    expect(await session(again)).not.toBeNull();
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
    await account().deleteAccount(deleteRequest(ada, "ada"));

    const early = new Date(clock.getTime() + ACCOUNT_PURGE_AFTER_MS - 1);
    expect(await purgeDeletedAccounts(env, early)).toMatchObject({ users: 0, lives: 0 });

    const later = new Date(clock.getTime() + ACCOUNT_PURGE_AFTER_MS);
    // A small budget takes several runs.
    const budget = { users: 5, page: 2, pages: 3 };
    const runs = [];
    for (let i = 0; i < 10; i++) {
      const run = await purgeDeletedAccounts(env, later, budget);
      runs.push(run);
      if (!run.more) break;
    }
    expect(runs.length).toBeGreaterThan(1);
    expect(runs.reduce((n, r) => n + r.lives, 0)).toBe(6);
    expect(runs.reduce((n, r) => n + r.versions, 0)).toBe(2);
    expect(runs.at(-1)).toMatchObject({ users: 1, more: false });

    expect(await count("SELECT count(*) AS n FROM users WHERE id = ?", ada.id)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM bots WHERE owner_id = ?", ada.id)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM versions WHERE id LIKE 'viper-%'")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM lives WHERE id LIKE 'viper-%'")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM ratings WHERE version_id LIKE 'viper-%'")).toBe(
      0,
    );
    for (const bucket of [env.BUNDLES, env.SOURCES, env.TRACES]) {
      const keys = (await bucket.list()).objects.map((o) => o.key);
      expect(keys.some((k) => k.includes("viper"))).toBe(false);
      expect(keys.some((k) => k.includes("cobra"))).toBe(true);
    }
    // Bob's life is still there; its killer now resolves to nothing.
    expect(await count("SELECT count(*) AS n FROM lives WHERE id LIKE 'cobra-%'")).toBe(6);
    const life = await env.DB.prepare(
      "SELECT killer FROM lives WHERE id = 'cobra-v2-life0'",
    ).first();
    expect(life).toEqual({ killer: "viper-v2" });
    expect(await purgeDeletedAccounts(env, later)).toMatchObject({ users: 0, more: false });
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
