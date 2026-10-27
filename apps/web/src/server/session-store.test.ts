import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { experimental_readRawConfig as readRawConfig } from "wrangler";
import { createDb } from "../db";
import { applyMigrations, createTestD1, dumpTables, type TestD1 } from "../test/d1";
import { hashToken } from "./cli-auth";
import {
  KV_MIN_TTL,
  kvSessionStore,
  pruneRevokedSessions,
  revokeAllSessions,
} from "./session-store";

let d1: TestD1;

describe("AUTH_KV binding", () => {
  const read = (app: string) =>
    readRawConfig({ config: join(import.meta.dirname, `../../../${app}/wrangler.jsonc`) })
      .rawConfig;
  const environments = (app: string): Record<string, { kv_namespaces?: { binding: string }[] }> => {
    const config = read(app);
    return { development: config, ...config.env };
  };

  it("is bound to the site in every environment", () => {
    for (const [name, config] of Object.entries(environments("web"))) {
      expect(
        config.kv_namespaces?.map((kv) => kv.binding),
        name,
      ).toContain("AUTH_KV");
    }
  });

  it("is never bound to the arena, which runs bot code", () => {
    for (const [name, config] of Object.entries(environments("arena"))) {
      expect(config.kv_namespaces ?? [], name).toEqual([]);
    }
  });
});

describe("kvSessionStore", () => {
  afterEach(() => d1.dispose());
  beforeEach(async () => {
    d1 = await createTestD1();
    await d1.db
      .prepare(
        "INSERT INTO users (id, name, email, username) VALUES ('u1', 'Ada', 'a@x.test', 'ada')",
      )
      .run();
  });

  const SESSION_TTL = 30 * 24 * 60 * 60;
  const store = (kv: KVNamespace = d1.kv) =>
    kvSessionStore(kv, createDb(d1.db), { sessionTtl: SESSION_TTL });
  const cachedSession = (token: string, createdAt = new Date()) =>
    JSON.stringify({ session: { token, userId: "u1", createdAt }, user: { id: "u1" } });
  const expiration = async (key: string) =>
    (await d1.kv.list({ prefix: key })).keys.find((k) => k.name === key)?.expiration;

  it("gives every value a KV TTL of at least a minute", async () => {
    await store().set("short", "v", 5);
    await store().set("long", "v", 3600);
    await store().set("none", "v");
    await store().set("zero", "v", 0);
    const now = Date.now() / 1000;
    for (const key of ["short", "none", "zero"]) {
      expect(await expiration(key), key).toBeGreaterThanOrEqual(Math.floor(now) + KV_MIN_TTL - 1);
      expect(await expiration(key), key).toBeLessThan(now + KV_MIN_TTL + 5);
    }
    expect(await expiration("long")).toBeGreaterThan(now + 3590);
  });

  it("serves the user from D1, not the copy cached at sign-in", async () => {
    const cached = {
      session: { token: "t", userId: "u1", createdAt: new Date().toISOString() },
      user: { id: "u1", username: null },
    };
    await store().set("t", JSON.stringify(cached), 3600);
    expect(JSON.parse(String(await store().get("t")))).toMatchObject({
      session: cached.session,
      user: { id: "u1", username: "ada", email: "a@x.test", bannedAt: null },
    });
    await revokeAllSessions(createDb(d1.db), "u1", new Date(0));
    expect(JSON.parse(String(await store().get("t"))).user).not.toHaveProperty("sessionsRevokedAt");

    await d1.db.prepare("DELETE FROM users WHERE id = 'u1'").run();
    expect(await store().get("t")).toBeNull();
  });

  it("passes other values through untouched", async () => {
    const list = JSON.stringify([{ token: "t", expiresAt: 1 }]);
    await store().set("active-sessions-u1", list, 3600);
    expect(await store().get("active-sessions-u1")).toBe(list);
    await store().delete("active-sessions-u1");
    expect(await store().get("active-sessions-u1")).toBeNull();
  });

  it("keeps verification values out of KV (they stay in D1)", async () => {
    await store().set("verification:state", "{}", 600);
    expect(await d1.kv.get("verification:state")).toBeNull();
    expect(await store().get("verification:state")).toBeNull();
  });

  it("revokes a deleted session in D1, by hash, so a stale KV copy is dead too", async () => {
    await store().set("t", cachedSession("t"), 3600);
    await store().delete("t");
    expect(await d1.kv.get("t")).toBeNull();
    const revoked = await d1.db.prepare("SELECT * FROM revoked_sessions").all();
    expect(revoked.results).toEqual([
      { token_hash: await hashToken("t"), expires_at: expect.any(Number) },
    ]);
    expect(JSON.stringify(revoked.results)).not.toContain('"t"');

    // Another location still has it, and Better Auth's refresh tries to write it back.
    await d1.kv.put("t", cachedSession("t"));
    expect(await store().get("t")).toBeNull();
    await d1.kv.delete("t");
    await store().set("t", cachedSession("t"), 30 * 24 * 3600);
    expect(await d1.kv.get("t")).toBeNull();
  });

  it("still deletes from KV, and fails loudly, when the revocation can't be written", async () => {
    await store().set("t", cachedSession("t"), 3600);
    await d1.db.prepare("DROP TABLE revoked_sessions").run();
    await expect(store().delete("t")).rejects.toThrow(/revoked_sessions/);
    expect(await d1.kv.get("t")).toBeNull();
  });

  it("ends every session created before a revoke-all, listed or not", async () => {
    await store().set("old", cachedSession("old", new Date(Date.now() - 1000)), 3600);
    await revokeAllSessions(createDb(d1.db), "u1");
    expect(await store().get("old")).toBeNull();
    await store().set("new", cachedSession("new", new Date(Date.now() + 1000)), 3600);
    expect(await store().get("new")).not.toBeNull();
  });

  it("prunes revoked tokens once they would have expired", async () => {
    await store().delete("t");
    const db = createDb(d1.db);
    await pruneRevokedSessions(db, new Date(Date.now() + (SESSION_TTL - 60) * 1000));
    expect(await d1.db.prepare("SELECT count(*) AS n FROM revoked_sessions").first("n")).toBe(1);
    await pruneRevokedSessions(db, new Date(Date.now() + (SESSION_TTL + 60) * 1000));
    expect(await d1.db.prepare("SELECT count(*) AS n FROM revoked_sessions").first("n")).toBe(0);
  });

  it("drops a write KV refuses for its one-write-per-second limit, and only that", async () => {
    const failing = (message: string) =>
      ({
        put: () => Promise.reject(new Error(message)),
      }) as unknown as KVNamespace;
    await expect(
      store(failing("KV PUT failed: 429 Too Many Requests")).set("t", cachedSession("t"), 3600),
    ).resolves.toBeUndefined();
    await expect(
      store(failing("KV PUT failed: 500 Internal Server Error")).set("t", cachedSession("t"), 3600),
    ).rejects.toThrow("500");
  });

  it("refuses the atomic operations KV can't do", async () => {
    await expect(store().getAndDelete("k")).rejects.toThrow();
    await expect(store().increment("k", 60)).rejects.toThrow();
  });
});

describe("migration 0011_web_sessions_to_kv", () => {
  const MIGRATION = "0011_web_sessions_to_kv.sql";
  afterEach(() => d1.dispose());

  it("empties the sessions table, keeping it for the site still running during the deploy", async () => {
    d1 = await createTestD1({ migrateBefore: MIGRATION });
    await d1.db.batch([
      d1.db.prepare("INSERT INTO users (id, name, email) VALUES ('u1', 'Ada', 'a@x.test')"),
      d1.db.prepare(
        "INSERT INTO sessions (id, expires_at, token, user_id, created_at, updated_at) VALUES ('s1', 1, 'old-plaintext-token', 'u1', 1, 1)",
      ),
    ]);
    expect(await dumpTables(d1.db)).toContain("old-plaintext-token");

    await applyMigrations(d1.db, undefined, MIGRATION);
    const dump = await dumpTables(d1.db);
    expect(dump).toContain("a@x.test");
    expect(dump).not.toContain("old-plaintext-token");
    expect(dump).toContain('"sessions":[]');
  });
});
