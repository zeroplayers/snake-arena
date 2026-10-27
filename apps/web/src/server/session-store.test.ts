import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { experimental_readRawConfig as readRawConfig } from "wrangler";
import { createDb } from "../db";
import { applyMigrations, createTestD1, dumpTables, type TestD1 } from "../test/d1";
import { KV_MIN_TTL, kvSessionStore } from "./session-store";

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

  const store = () => kvSessionStore(d1.kv, createDb(d1.db));
  const expiration = async (key: string) =>
    (await d1.kv.list({ prefix: key })).keys.find((k) => k.name === key)?.expiration;

  it("gives every value a KV TTL of at least a minute", async () => {
    await store().set("short", "v", 5);
    await store().set("long", "v", 3600);
    const now = Date.now() / 1000;
    expect(await expiration("short")).toBeGreaterThanOrEqual(Math.floor(now) + KV_MIN_TTL - 1);
    expect(await expiration("short")).toBeLessThan(now + KV_MIN_TTL + 5);
    expect(await expiration("long")).toBeGreaterThan(now + 3590);
  });

  it("serves the user from D1, not the copy cached at sign-in", async () => {
    const cached = { session: { token: "t", userId: "u1" }, user: { id: "u1", username: null } };
    await store().set("t", JSON.stringify(cached), 3600);
    expect(JSON.parse(String(await store().get("t")))).toMatchObject({
      session: cached.session,
      user: { id: "u1", username: "ada", email: "a@x.test", bannedAt: null },
    });

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

  it("refuses the atomic operations KV can't do", () => {
    expect(() => store().getAndDelete("k")).toThrow();
    expect(() => store().increment("k", 60)).toThrow();
  });
});

describe("migration 0011_web_sessions_to_kv", () => {
  const MIGRATION = "0011_web_sessions_to_kv.sql";
  afterEach(() => d1.dispose());

  it("drops the sessions table and every token in it", async () => {
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
    expect(dump).not.toContain('"sessions"');
  });
});
