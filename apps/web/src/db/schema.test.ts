import { getAuthTables } from "better-auth/db";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../server/auth";
import { createTestD1, type TestD1 } from "../test/d1";
import { createDb, type Db } from ".";
import { getLeaderboard, getProfile, leaderboardQuery, RANKED_MIN_LIVES } from "./queries";
import { authSchema } from "./schema";

let d1: TestD1;
let db: Db;

beforeAll(async () => {
  d1 = await createTestD1({ seed: true });
  db = createDb(d1.db);
});

afterAll(() => d1.dispose());

describe("Better Auth tables", () => {
  const auth = createAuth({
    DB: {} as D1Database,
    BETTER_AUTH_URL: "http://localhost:3000",
    BETTER_AUTH_SECRET: "x".repeat(32),
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret",
  });
  const tables = getAuthTables(auth.options);

  it.each(Object.entries(tables))("has every field of `%s`", (model, table) => {
    const drizzleTable = (authSchema as Record<string, SQLiteTable>)[`${model}s`];
    expect(drizzleTable, `authSchema.${model}s`).toBeDefined();
    if (!drizzleTable) return;
    const columns = getTableColumns(drizzleTable);
    for (const field of Object.keys(table.fields)) {
      expect(columns, `${model}.${field}`).toHaveProperty(field);
    }
  });

  it("covers the whole auth schema", () => {
    // rateLimit only exists with `rateLimit.storage: "database"`, which we don't use.
    const expected = Object.keys(tables)
      .filter((m) => m !== "rateLimit")
      .map((m) => `${m}s`)
      .sort();
    expect(Object.keys(authSchema).sort()).toEqual(expected);
  });
});

describe("migrations", () => {
  it("create every table in the Drizzle schema", async () => {
    const { results } = await d1.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%'",
      )
      .all<{ name: string }>();
    const schema = await import("./schema");
    const expected = new Set(
      Object.values(schema)
        .filter((v) => is(v, SQLiteTable))
        .map((t) => getTableName(t)),
    );
    expect(results.map((r) => r.name).sort()).toEqual([...expected].sort());
  });

  it("declare the indexes in the Drizzle schema", async () => {
    const { versions } = await import("./schema");
    const names = getTableConfig(versions).indexes.map((i) => i.config.name);
    const { results } = await d1.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'versions'")
      .all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(expect.arrayContaining(names));
  });
});

describe("constraints", () => {
  const insertVersion = (id: string, botId: string, n: number, status: string) =>
    d1.db
      .prepare(
        "INSERT INTO versions (id, bot_id, n, status, bundle_key, source_key) VALUES (?, ?, ?, ?, 'b', 's')",
      )
      .bind(id, botId, n, status)
      .run();

  it("allows one ready version per bot", async () => {
    await expect(insertVersion("t-1", "seed-coward", 2, "ready")).rejects.toThrow(/UNIQUE/);
    await insertVersion("t-2", "seed-coward", 2, "validating");
    await d1.db.prepare("DELETE FROM versions WHERE id = 't-2'").run();
  });

  it("numbers versions uniquely per bot", async () => {
    await expect(insertVersion("t-3", "seed-coward", 1, "archived")).rejects.toThrow(/UNIQUE/);
  });

  it("checks enums", async () => {
    await expect(insertVersion("t-4", "seed-coward", 9, "live")).rejects.toThrow(/CHECK/);
    await expect(
      d1.db
        .prepare(
          "INSERT INTO lives (id, version_id, room, start_tick, death_cause) VALUES ('t-l', 'seed-coward-1', 'r', 0, 'boredom')",
        )
        .run(),
    ).rejects.toThrow(/CHECK/);
  });

  it("bumps change_seq when a version is quarantined or released", async () => {
    const seq = async () =>
      (
        await d1.db
          .prepare("SELECT change_seq FROM versions WHERE id = 'seed-coward-1'")
          .first<{ change_seq: number }>()
      )?.change_seq ?? 0;
    const max = async () =>
      (await d1.db.prepare("SELECT max(change_seq) AS m FROM versions").first<{ m: number }>())
        ?.m ?? 0;
    const quarantine = (at: number | null) =>
      d1.db
        .prepare("UPDATE versions SET quarantined_at = ? WHERE id = 'seed-coward-1'")
        .bind(at)
        .run();
    await quarantine(1);
    expect(await seq()).toBe(await max());
    const after = await seq();
    // The same value again isn't a change.
    await quarantine(1);
    expect(await seq()).toBe(after);
    await quarantine(null);
    expect(await seq()).toBe(after + 1);
  });

  it("enforces foreign keys", async () => {
    await expect(insertVersion("t-5", "no-such-bot", 1, "validating")).rejects.toThrow(
      /FOREIGN KEY/,
    );
  });
});

describe("seed", () => {
  it("covers every version status", async () => {
    const { results } = await d1.db
      .prepare("SELECT DISTINCT status FROM versions ORDER BY status")
      .all<{ status: string }>();
    expect(results.map((r) => r.status)).toEqual(["archived", "ready", "rejected", "validating"]);
  });

  it("is re-runnable", async () => {
    const count = () => d1.db.prepare("SELECT count(*) AS n FROM lives").first<{ n: number }>("n");
    const before = await count();
    const { execFile, seedFile } = await import("../test/d1");
    await execFile(d1.db, seedFile);
    expect(await count()).toBe(before);
    expect(before).toBeGreaterThan(500);
  });

  it("rates the last 200 lives", async () => {
    const greedy = await d1.db
      .prepare("SELECT n_lives FROM ratings WHERE version_id = 'seed-greedy-2'")
      .first<number>("n_lives");
    expect(greedy).toBe(200);
  });
});

describe("leaderboard", () => {
  it("ranks active versions with enough lives, best first", async () => {
    const board = await getLeaderboard(db);
    expect(board.map((e) => [e.rank, e.author, e.botName, e.version])).toEqual([
      [1, "ada", "Greedy", 2],
      [2, "linus", "Spiral", 2],
      [3, "ada", "Coward", 1],
    ]);
    expect(board.every((e) => e.lives >= RANKED_MIN_LIVES)).toBe(true);
    expect(board[0]?.ratingCi).toBeGreaterThan(0);
  });

  it("drops quarantined versions, so a frozen rank can't be kept", async () => {
    const set = (at: number | null) =>
      d1.db
        .prepare("UPDATE versions SET quarantined_at = ? WHERE id = 'seed-greedy-2'")
        .bind(at)
        .run();
    await set(1);
    try {
      const board = await getLeaderboard(db);
      expect(board.map((e) => [e.rank, e.botName])).toEqual([
        [1, "Spiral"],
        [2, "Coward"],
      ]);
    } finally {
      await set(null);
    }
  });

  it("pages", async () => {
    const page = await getLeaderboard(db, { limit: 1, offset: 1 });
    expect(page).toMatchObject([{ rank: 2, botName: "Spiral" }]);
  });
});

describe("profile", () => {
  it("lists the author's bots with their active version", async () => {
    const profile = await getProfile(db, "Ada");
    expect(profile).toMatchObject({ username: "ada", avatarUrl: null });
    expect(profile?.bots).toEqual([
      {
        id: "seed-greedy",
        name: "Greedy",
        slug: "greedy",
        activeVersion: 2,
        rating: 79.5,
        ratingCi: expect.closeTo(1.6, 2),
        ratedLives: 200,
        lives: 320,
      },
      {
        id: "seed-coward",
        name: "Coward",
        slug: "coward",
        activeVersion: 1,
        rating: 37,
        ratingCi: expect.closeTo(0.69, 2),
        ratedLives: 150,
        lives: 150,
      },
    ]);
  });

  it("shows bots without an active version", async () => {
    const profile = await getProfile(db, "grace");
    expect(profile?.bots.find((b) => b.id === "seed-wip")).toMatchObject({
      activeVersion: null,
      rating: null,
      lives: 0,
    });
  });

  it("is null for unknown users", async () => {
    expect(await getProfile(db, "nobody")).toBeNull();
  });
});

describe("indexes", () => {
  const plan = async (query: string, params: unknown[] = []) => {
    const { results } = await d1.db
      .prepare(`EXPLAIN QUERY PLAN ${query}`)
      .bind(...params)
      .all<{ detail: string }>();
    return results.map((r) => r.detail).join("\n");
  };

  it("serve the leaderboard in rating order without sorting", async () => {
    const query = leaderboardQuery(db).toSQL();
    const detail = await plan(query.sql, query.params);
    expect(detail).toMatch(/ratings_rank_idx/);
    expect(detail).not.toMatch(/TEMP B-TREE/);
  });

  it("serve a bot's versions and a version's latest lives", async () => {
    expect(await plan("SELECT * FROM versions WHERE bot_id = 'x' ORDER BY n DESC")).toMatch(
      /versions_bot_n_idx/,
    );
    const lives = await plan(
      "SELECT * FROM lives WHERE version_id = 'x' ORDER BY ended_at DESC LIMIT 200",
    );
    expect(lives).toMatch(/lives_version_ended_idx/);
    expect(lives).not.toMatch(/TEMP B-TREE/);
  });

  it("serve a user's bots", async () => {
    expect(await plan("SELECT * FROM bots WHERE owner_id = 'x'")).toMatch(/bots_owner_slug_idx/);
  });
});
