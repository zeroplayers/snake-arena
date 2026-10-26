import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPagesSeed, REPLAY_ROOM, REPLAY_TICKS } from "../../seed/pages-data";
import { createDb, type Db } from "../db";
import { getLeaderboard, getProfile } from "../db/queries";
import { createTestD1, type TestD1 } from "../test/d1";
import { getBotPage, RECENT_LIVES } from "./bot";
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
    expect((await getBotPage(db, "ada", "greedy", 1))?.selected?.n).toBe(1);
    expect(await getBotPage(db, "ada", "greedy", 9)).toBeNull();
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

  it("lists the latest finished lives with causes and killers", async () => {
    const lives = (await getBotPage(db, "ada", "greedy"))?.selected?.recentLives ?? [];
    expect(lives).toHaveLength(RECENT_LIVES);
    const ended = lives.map((l) => l.endedAt as string);
    expect(ended).toEqual([...ended].sort().reverse());
    // The recorded match is the newest, so it comes first and has replays.
    expect(lives[0]?.id).toMatch(/^seed-replay-greedy-/);
    expect(lives[0]?.hasReplay).toBe(true);

    const all = (await getBotPage(db, "ada", "coward"))?.selected?.recentLives ?? [];
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
    const causes = (await getBotPage(db, "ada", "greedy", 1))?.selected?.causes ?? [];
    expect(causes.reduce((n, c) => n + c.count, 0)).toBe(120);
    expect(causes[0]?.cause).toBe("collision");
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
      hasReplay: true,
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
