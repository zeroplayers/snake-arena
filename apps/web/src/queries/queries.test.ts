import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPagesSeed, REPLAY_ROOM, REPLAY_TICKS } from "../../seed/pages-data";
import { createDb, type Db } from "../db";
import { getLeaderboard, getProfile } from "../db/queries";
import { createTestD1, type TestD1 } from "../test/d1";
import { CAUSES_WINDOW, getBotPage, RECENT_LIVES, VERSIONS_PER_PAGE } from "./bot";
import { getParticipants, getReplayKey, getReplayLife } from "./replay";

let d1: TestD1;
let db: Db;
let seed: ReturnType<typeof buildPagesSeed>;

beforeAll(async () => {
  d1 = await createTestD1({ seed: true });
  db = createDb(d1.db);
  seed = buildPagesSeed();
  await d1.db.batch(seed.statements.map((s) => d1.db.prepare(s)));
}, 30_000);

afterAll(() => d1.dispose());

describe("leaderboard and profile", () => {
  it("link entries to bot pages", async () => {
    const rows = await getLeaderboard(db);
    expect(rows.map((r) => `${r.author}/${r.botSlug}`)).toEqual([
      "ada/greedy",
      "linus/spiral",
      "ada/coward",
    ]);
  });

  it("list an author's bots with slugs and rating CI", async () => {
    const profile = await getProfile(db, "ada");
    expect(profile?.bots.map((b) => [b.slug, b.activeVersion, b.ratedLives])).toEqual([
      ["greedy", 2, 200],
      ["coward", 1, 150],
    ]);
    expect(profile?.bots[0]?.ratingCi).toBeGreaterThan(0);
  });

  it("show an author without bots as empty", async () => {
    expect((await getProfile(db, "newbie"))?.bots).toEqual([]);
  });
});

describe("getBotPage", () => {
  it("lists versions newest first with ratings and life counts", async () => {
    const page = await getBotPage(db, "ada", "greedy");
    expect(page?.bot.name).toBe("Greedy");
    expect(page?.versions.map((v) => [v.n, v.status, v.ratedLives])).toEqual([
      [2, "ready", 200],
      [1, "archived", 120],
    ]);
    const replayLives = (await getParticipants(db, REPLAY_ROOM, 0, REPLAY_TICKS)).filter(
      (p) => p.botSlug === "greedy",
    ).length;
    expect(page?.versions[0]?.lives).toBe(200 + replayLives);
  });

  it("selects the active version by default, another with `versionN`", async () => {
    expect((await getBotPage(db, "ada", "greedy"))?.selected?.n).toBe(2);
    expect((await getBotPage(db, "ada", "greedy", { version: 1 }))?.selected?.n).toBe(1);
    expect(await getBotPage(db, "ada", "greedy", { version: 9 })).toBeNull();
  });

  it("falls back to the newest version without an active one", async () => {
    const page = await getBotPage(db, "grace", "wip");
    expect(page?.selected).toMatchObject({ n: 1, recentLives: [], causes: [] });
  });

  it("shows a bot without versions", async () => {
    const page = await getBotPage(db, "linus", "draft");
    expect(page?.versions).toEqual([]);
    expect(page?.selected).toBeNull();
  });

  it("is null for unknown authors and bots, case-insensitive otherwise", async () => {
    expect(await getBotPage(db, "nobody", "greedy")).toBeNull();
    expect(await getBotPage(db, "ada", "nope")).toBeNull();
    expect(await getBotPage(db, "linus", "greedy")).toBeNull();
    expect((await getBotPage(db, "ADA", "Greedy"))?.bot.slug).toBe("greedy");
  });

  it("explains rejected versions", async () => {
    const page = await getBotPage(db, "linus", "spiral");
    expect(page?.versions.find((v) => v.n === 1)?.rejection).toMatch(/^seeds: .*op budget/);
    expect(page?.versions.find((v) => v.n === 2)?.rejection).toBeNull();
  });

  it("marks versions the arena quarantined", async () => {
    const versionOf = async () =>
      (await getBotPage(db, "linus", "spiral"))?.versions.find((v) => v.n === 2);
    expect((await versionOf())?.quarantine).toBeNull();
    const at = Date.parse("2026-10-26T13:00:00.000Z");
    const set = (value: number | null) =>
      d1.db
        .prepare(
          `UPDATE versions SET quarantined_at = ?, quarantine_reason = 'CPU limit'
           WHERE n = 2 AND bot_id = (SELECT id FROM bots WHERE slug = 'spiral')`,
        )
        .bind(value)
        .run();
    await set(at);
    try {
      expect((await versionOf())?.quarantine).toEqual({
        at: new Date(at).toISOString(),
        reason: "CPU limit",
      });
    } finally {
      await set(null);
    }
  });

  it("lists the latest finished lives with causes and killers", async () => {
    const lives = (await getBotPage(db, "ada", "greedy"))?.selected?.recentLives ?? [];
    expect(lives).toHaveLength(RECENT_LIVES);
    const ended = lives.map((l) => l.endedAt as string);
    expect(ended).toEqual([...ended].sort().reverse());

    const all = (await getBotPage(db, "ada", "coward"))?.selected?.recentLives ?? [];
    // The recorded match is the newest, so its lives come first and have replays. (Coward, an
    // easy bot, dies a dozen times in it; whether greedy dies at all depends on the engine.)
    expect(all[0]?.id).toMatch(/^seed-replay-coward-/);
    expect(all[0]?.hasReplay).toBe(true);
    const killers = all.flatMap((l) => (l.killer ? [l.killer.kind] : []));
    expect(killers).toContain("house");
    expect(killers).toContain("bot");
    const byBot = all.find((l) => l.killer?.kind === "bot")?.killer;
    expect(byBot).toMatchObject({
      kind: "bot",
      author: expect.any(String),
      version: expect.any(Number),
    });
  });

  it("counts deaths by cause, most common first", async () => {
    const causes = (await getBotPage(db, "ada", "greedy", { version: 1 }))?.selected?.causes ?? [];
    expect(causes.reduce((n, c) => n + c.count, 0)).toBe(120);
    expect(causes[0]?.ending).toBe("collision");
    // The seed's `retired` lives end short of a life cap: their versions were stopped.
    expect(causes.map((c) => c.ending)).toContain("stopped");
    expect(causes.map((c) => c.ending)).not.toContain("capped");
    const counts = causes.map((c) => c.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });
});

describe("replay queries", () => {
  it("find a life with its bot and replay key", async () => {
    const life = await getReplayLife(db, "seed-replay-greedy-1");
    expect(life).toMatchObject({
      author: "ada",
      botSlug: "greedy",
      version: 2,
      room: REPLAY_ROOM,
      replayRecorded: true,
      replayExpired: false,
    });
    expect(life).not.toHaveProperty("replayKey");
    expect(await getReplayKey(db, "seed-replay-greedy-1")).toMatch(/\.bin$/);
    expect(await getReplayLife(db, "nope")).toBeNull();
  });

  it("list the lives in a room over a tick range", async () => {
    const all = await getParticipants(db, REPLAY_ROOM, 0, REPLAY_TICKS);
    expect(all.length).toBeGreaterThan(10);
    expect(new Set(all.map((p) => p.author))).toEqual(new Set(["ada", "linus", "grace"]));
    const late = await getParticipants(db, REPLAY_ROOM, REPLAY_TICKS - 1, REPLAY_TICKS);
    expect(late.length).toBeLessThan(all.length);
    expect(await getParticipants(db, "elsewhere", 0, REPLAY_TICKS)).toEqual([]);
  });
});

describe("bounded page cost", () => {
  const run = (sql: string, ...params: unknown[]) =>
    d1.db
      .prepare(sql)
      .bind(...params)
      .run();
  const livesCount = async (versionId: string) =>
    (
      await d1.db
        .prepare("SELECT lives_count AS n FROM versions WHERE id = ?")
        .bind(versionId)
        .first<{ n: number }>()
    )?.n;

  it("keeps `versions.lives_count` equal to the lives rows", async () => {
    const { results } = await d1.db
      .prepare(
        `SELECT v.id, v.lives_count AS kept, (SELECT count(*) FROM lives WHERE version_id = v.id) AS real
         FROM versions v`,
      )
      .all<{ kept: number; real: number }>();
    expect(results.length).toBeGreaterThan(5);
    for (const r of results) expect(r.kept).toBe(r.real);

    const before = (await livesCount("seed-hunter-1")) ?? 0;
    await run(
      "INSERT INTO lives (id, version_id, room, start_tick) VALUES ('t-life', 'seed-hunter-1', 'r', 0)",
    );
    expect(await livesCount("seed-hunter-1")).toBe(before + 1);
    await run("UPDATE lives SET version_id = 'seed-wip-1' WHERE id = 't-life'");
    expect(await livesCount("seed-hunter-1")).toBe(before);
    expect(await livesCount("seed-wip-1")).toBe(1);
    await run("DELETE FROM lives WHERE id = 't-life'");
    expect(await livesCount("seed-wip-1")).toBe(0);
  });

  it("pages a bot with more versions than D1 has bound parameters", async () => {
    const total = 120;
    await run(
      "INSERT INTO bots (id, owner_id, name, slug) VALUES ('t-many', 'seed-linus', 'Many', 'many')",
    );
    await d1.db.batch(
      Array.from({ length: total }, (_, i) =>
        d1.db
          .prepare(
            "INSERT INTO versions (id, bot_id, n, status, bundle_key, source_key) VALUES (?, 't-many', ?, ?, 'b', 's')",
          )
          .bind(`t-many-${i + 1}`, i + 1, i + 1 === 7 ? "ready" : "archived"),
      ),
    );
    await run(
      "INSERT INTO lives (id, version_id, room, start_tick, end_tick, ended_at, death_cause) VALUES ('t-many-life', 't-many-120', 'r', 0, 10, 1, 'wall')",
    );

    const first = await getBotPage(db, "linus", "many");
    expect(first?.versions).toHaveLength(VERSIONS_PER_PAGE);
    expect(first?.versions[0]).toMatchObject({ n: 120, lives: 1 });
    expect(first?.hasOlder).toBe(true);
    // The active version is off the first page but still found and selected.
    expect(first?.active?.n).toBe(7);
    expect(first?.selected?.n).toBe(7);

    const last = await getBotPage(db, "linus", "many", { page: 3 });
    expect(last?.versions.map((v) => v.n)).toEqual(
      Array.from(
        { length: total - 2 * VERSIONS_PER_PAGE },
        (_, i) => total - 2 * VERSIONS_PER_PAGE - i,
      ),
    );
    expect(last?.hasOlder).toBe(false);
    expect((await getBotPage(db, "linus", "many", { page: 9 }))?.versions).toEqual([]);
    expect((await getBotPage(db, "linus", "many", { version: 120 }))?.selected).toMatchObject({
      n: 120,
      causes: [{ ending: "wall", count: 1 }],
    });
  });

  it("counts death causes over the latest lives only", async () => {
    // greedy v2 has more finished lives than the window (dev.sql plus the recorded match).
    const page = await getBotPage(db, "ada", "greedy");
    expect(page?.selected && page.versions[0]?.lives).toBeGreaterThan(CAUSES_WINDOW);
    const causes = page?.selected?.causes ?? [];
    expect(causes.reduce((n, c) => n + c.count, 0)).toBe(CAUSES_WINDOW);
  });

  it("counts an author's lives from the counters", async () => {
    const profile = await getProfile(db, "ada");
    const page = await getBotPage(db, "ada", "greedy");
    const sum = (page?.versions ?? []).reduce((n, v) => n + v.lives, 0);
    expect(profile?.bots.find((b) => b.slug === "greedy")?.lives).toBe(sum);
  });
});

describe("leaderboard order", () => {
  it("ranks by the lower bound, not the mean", async () => {
    // A lucky 30-life version with a high mean and a wide interval, and a steady one.
    await d1.db.batch([
      d1.db.prepare(
        "INSERT INTO bots (id, owner_id, name, slug) VALUES ('t-lucky', 'seed-grace', 'Lucky', 'lucky'), ('t-steady', 'seed-grace', 'Steady', 'steady')",
      ),
      d1.db.prepare(
        "INSERT INTO versions (id, bot_id, n, status, bundle_key, source_key) VALUES ('t-lucky-1', 't-lucky', 1, 'ready', 'b', 's'), ('t-steady-1', 't-steady', 1, 'ready', 'b', 's')",
      ),
      d1.db.prepare(
        "INSERT INTO ratings (version_id, mean, ci, n_lives, alive_ticks) VALUES ('t-lucky-1', 500, 450, 30, 36000), ('t-steady-1', 300, 20, 200, 500000)",
      ),
    ]);
    const rows = await getLeaderboard(db);
    const names = rows.map((r) => r.botSlug);
    expect(names.indexOf("steady")).toBeLessThan(names.indexOf("lucky"));
    expect(names[0]).toBe("steady");
    const lowers = rows.map((r) => r.lowerBound);
    expect(lowers).toEqual([...lowers].sort((a, b) => b - a));
    expect(rows.find((r) => r.botSlug === "lucky")).toMatchObject({
      lowerBound: 50,
      ratedLives: 30,
    });
  });

  it("leaves out archived bots", async () => {
    await d1.db.batch([
      d1.db.prepare(
        "INSERT INTO bots (id, owner_id, name, slug) VALUES ('t-gone', 'seed-grace', 'Gone', 'gone')",
      ),
      d1.db.prepare(
        "INSERT INTO versions (id, bot_id, n, status, bundle_key, source_key) VALUES ('t-gone-1', 't-gone', 1, 'ready', 'b', 's')",
      ),
      d1.db.prepare(
        "INSERT INTO ratings (version_id, mean, ci, n_lives, alive_ticks) VALUES ('t-gone-1', 900, 10, 200, 500000)",
      ),
    ]);
    expect((await getLeaderboard(db))[0]?.botSlug).toBe("gone");
    // A `ready` version on an archived bot breaks an invariant; the leaderboard still holds.
    await d1.db.prepare("UPDATE bots SET archived_at = 1 WHERE id = 't-gone'").run();
    expect((await getLeaderboard(db)).map((r) => r.botSlug)).not.toContain("gone");
  });
});
