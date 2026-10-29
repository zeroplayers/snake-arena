/**
 * The rating job against real D1 (workerd): ratings from `lives`, the leaderboard order, the
 * cursor, idempotency, stints and the per-run budget.
 */
import { join } from "node:path";
import { createRatingState, DEFAULT_RATING_CONFIG, rate } from "@zerosnake/rating";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { experimental_readRawConfig as readRawConfig } from "wrangler";
import { createDb } from "../db";
import { getLeaderboard } from "../db/queries";
import { applyMigrations, createTestD1, type TestD1 } from "../test/d1";
import { RATINGS_CRON, rebuildRatings, runRatingJob, updateRatings } from "./ratings";

const NOW = new Date("2026-10-27T12:00:00Z");
const T0 = NOW.getTime() - 86_400_000;

let d1: TestD1;

beforeEach(async () => {
  d1 = await createTestD1();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await d1.dispose();
});

/** A user with bot `bot` whose version `bot-1` is `ready`, activated at `activatedAt`. */
async function readyBot(bot: string, activatedAt: number | null = T0) {
  await d1.db.batch([
    d1.db
      .prepare("INSERT INTO users (id, name, email, username) VALUES (?1, ?1, ?1 || '@x.test', ?1)")
      .bind(`u-${bot}`),
    d1.db
      .prepare("INSERT INTO bots (id, owner_id, name, slug) VALUES (?1, ?2, ?1, ?1)")
      .bind(bot, `u-${bot}`),
    d1.db
      .prepare(
        `INSERT INTO versions (id, bot_id, n, status, bundle_key, source_key, activated_at)
         VALUES (?1, ?2, 1, 'ready', 'b.js', 's.json', ?3)`,
      )
      .bind(`${bot}-1`, bot, activatedAt),
  ]);
  return `${bot}-1`;
}

interface LifeOptions {
  startedAt?: number;
  deathCause?: string;
  /** Ticks alive (`end_tick`, from `start_tick` 0); a minute by default, so the rating, in
   * points per minute, is the mean score. */
  ticks?: number;
  /** Written while alive (`end_tick` null), as a writer that records starts would. */
  alive?: boolean;
  ids?: string[];
}

let lifeCounter = 0;

/** Lives of `version` with `scores`, written as the arena does (`ON CONFLICT DO NOTHING`). */
async function addLives(version: string, scores: readonly number[], options: LifeOptions = {}) {
  const ids = options.ids ?? scores.map(() => `life-${++lifeCounter}`);
  const startedAt = options.startedAt ?? T0 + 1000;
  for (let i = 0; i < scores.length; i += 500) {
    await d1.db.batch(
      scores.slice(i, i + 500).map((score, j) =>
        d1.db
          .prepare(
            `INSERT INTO lives (id, version_id, room, start_tick, end_tick, score, death_cause,
               started_at, ended_at)
             VALUES (?1, ?2, 'room', 0, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (id) DO NOTHING`,
          )
          .bind(
            ids[i + j],
            version,
            options.alive ? null : (options.ticks ?? 600),
            score,
            options.alive ? null : (options.deathCause ?? "collision"),
            startedAt,
            options.alive ? null : startedAt + 60_000,
          ),
      ),
    );
  }
  return ids;
}

async function rating(version: string) {
  return d1.db
    .prepare(
      `SELECT mean, ci, lower_bound, n_lives, alive_ticks, activated_at, recent_scores, life_seq
       FROM ratings WHERE version_id = ?`,
    )
    .bind(version)
    .first<{
      mean: number;
      ci: number;
      lower_bound: number;
      n_lives: number;
      alive_ticks: number;
      activated_at: number | null;
      recent_scores: string;
      life_seq: number | null;
    }>();
}

async function progress() {
  return d1.db
    .prepare("SELECT assigned_seq, rated_seq, rev FROM rating_progress WHERE id = 1")
    .first<{ assigned_seq: number; rated_seq: number; rev: number }>();
}

const run = (options?: Parameters<typeof updateRatings>[2]) => updateRatings(d1.db, NOW, options);

/** What `@zerosnake/rating` says the rating of these lives (oldest first, `ticks` each) is. */
function expected(scores: number[], ticks = 600) {
  const r = rate(createRatingState(scores.map((score) => ({ score, ticks }))));
  if (!r) throw new Error("no lives");
  return r;
}

const scoresOf = (n: number, base: number, spread = 40) =>
  Array.from({ length: n }, (_, i) => base + ((i * 7919) % spread));

describe("updateRatings", () => {
  it("rates a version from its lives, as @zerosnake/rating does", async () => {
    const v = await readyBot("a");
    const scores = scoresOf(250, 100);
    await addLives(v, scores);
    const result = await run();
    expect(result).toMatchObject({ lives: 250, ratings: 1, ratedSeq: 250, more: false });
    const row = await rating(v);
    const want = expected(scores);
    expect(row?.n_lives).toBe(250);
    expect(row?.alive_ticks).toBe(250 * 600);
    expect(row?.mean).toBeCloseTo(want.mean, 9);
    expect(row?.ci).toBeCloseTo(want.ci, 9);
    expect(row?.lower_bound).toBeCloseTo(want.mean - want.ci, 9);
    expect(row?.activated_at).toBe(T0);
    expect(row?.life_seq).toBe(250);
    expect(JSON.parse(row?.recent_scores ?? "")).toEqual({
      v: 2,
      scoring: "raw",
      lives: scores.slice(-DEFAULT_RATING_CONFIG.window).map((s) => [s, 600]),
    });
  });

  it("rates points per minute alive: total score over total time", async () => {
    const v = await readyBot("a");
    await addLives(v, [100], { ticks: 600 });
    await addLives(v, [500], { ticks: 5400 });
    await run();
    // 600 points in 10 minutes, not the mean of 100 and 500.
    expect(await rating(v)).toMatchObject({ n_lives: 2, alive_ticks: 6000, mean: 60 });
  });

  it("puts versions on the leaderboard from an hour alive, ranked by the lower bound", async () => {
    // `steady` has the lower rate but a much tighter interval, so it ranks first.
    const steady = await readyBot("steady");
    const lucky = await readyBot("lucky");
    const fresh = await readyBot("fresh");
    await addLives(steady, scoresOf(200, 100, 10));
    // 40 lives of two minutes: 80 minutes alive.
    await addLives(lucky, [...scoresOf(35, 0, 5), ...scoresOf(5, 4000, 50)], { ticks: 1200 });
    // 59 one-minute lives, whatever their scores: under the hour.
    await addLives(fresh, scoresOf(59, 500));
    await run();

    const board = await getLeaderboard(createDb(d1.db));
    expect(board.map((r) => r.botId)).toEqual(["steady", "lucky"]);
    const [first, second] = board;
    expect(first?.rating).toBeLessThan(second?.rating ?? 0);
    expect(first?.lowerBound).toBeGreaterThan(second?.lowerBound ?? 0);
    expect(second?.ratedMinutes).toBe(80);
    expect(await rating(fresh)).toMatchObject({ n_lives: 59, alive_ticks: 59 * 600 });

    await addLives(fresh, [500]);
    await run();
    expect((await getLeaderboard(createDb(d1.db))).map((r) => r.botId)).toContain("fresh");
  });

  it("writes no rating for a single life, and one from the second", async () => {
    const v = await readyBot("a");
    await addLives(v, [10]);
    await run();
    expect(await rating(v)).toBeNull();
    await addLives(v, [30]);
    await run();
    expect(await rating(v)).toMatchObject({ n_lives: 2, mean: 20 });
  });

  it("adds new lives to the stored window across runs", async () => {
    const v = await readyBot("a");
    const scores = scoresOf(450, 50, 97);
    for (let i = 0; i < scores.length; i += 90) {
      await addLives(v, scores.slice(i, i + 90));
      await run();
    }
    const row = await rating(v);
    expect(row?.n_lives).toBe(450);
    expect(row?.mean).toBeCloseTo(expected(scores).mean, 9);
    expect(row?.ci).toBeCloseTo(expected(scores).ci, 9);
  });

  it("doesn't count lives the platform retired, but counts lives that reached the cap", async () => {
    const v = await readyBot("a");
    await addLives(v, [10, 20, 30]);
    // Stopped (version archived, arena paused...) short of a cap: not counted.
    await addLives(v, [5000, 5000], { deathCause: "retired" });
    await run();
    expect(await rating(v)).toMatchObject({ n_lives: 3, mean: 20 });
    // Reached the 24-hour cap (864 000 ticks), or the old 10-minute one (6000): counted.
    await addLives(v, [1440 * 100], { deathCause: "retired", ticks: 864_000 });
    await addLives(v, [1000], { deathCause: "retired", ticks: 6000 });
    await run();
    const row = await rating(v);
    expect(row).toMatchObject({ n_lives: 5, alive_ticks: 3 * 600 + 864_000 + 6000 });
    expect(row?.mean).toBeCloseTo((60 + 144_000 + 1000) / (3 + 1440 + 10), 9);
    // A rebuild counts the same lives.
    await d1.db.prepare("UPDATE ratings SET life_seq = NULL").run();
    await run();
    expect(await rating(v)).toEqual(row);
  });

  it("continues from its cursor when a run hits its budget", async () => {
    const a = await readyBot("a");
    const b = await readyBot("b");
    const aScores = scoresOf(300, 10, 31);
    const bScores = scoresOf(300, 70, 13);
    // Interleaved, as rooms would write them.
    for (let i = 0; i < 300; i += 50) {
      await addLives(a, aScores.slice(i, i + 50));
      await addLives(b, bScores.slice(i, i + 50));
    }
    const first = await run({ maxLives: 250, batchLives: 100 });
    expect(first).toMatchObject({ lives: 250, ratedSeq: 250, assignedSeq: 600, more: true });
    expect((await progress())?.rated_seq).toBe(250);
    const second = await run({ maxLives: 250, batchLives: 100 });
    expect(second).toMatchObject({ lives: 250, ratedSeq: 500, more: true });
    const third = await run({ maxLives: 250, batchLives: 100 });
    expect(third).toMatchObject({ lives: 100, ratedSeq: 600, more: false });
    expect(await run()).toMatchObject({ lives: 0, ratings: 0, more: false });

    for (const [v, scores] of [
      [a, aScores],
      [b, bScores],
    ] as const) {
      const row = await rating(v);
      expect(row?.n_lives).toBe(300);
      expect(row?.mean).toBeCloseTo(expected(scores).mean, 9);
    }
  });

  it("counts lives the arena writes late, in the order they were written", async () => {
    const v = await readyBot("a");
    await addLives(v, [10, 20], { startedAt: T0 + 50_000 });
    await run();
    // Started earlier, written after the replay chunk was uploaded.
    await addLives(v, [60], { startedAt: T0 + 10_000 });
    await run();
    const row = await rating(v);
    expect(row).toMatchObject({ n_lives: 3, mean: 30 });
    expect(JSON.parse(row?.recent_scores ?? "").lives.map(([s]: number[]) => s)).toEqual([
      10, 20, 60,
    ]);
  });

  it("numbers a life written while alive when it ends", async () => {
    const v = await readyBot("a");
    const [alive] = await addLives(v, [0], { alive: true });
    await addLives(v, [10, 20]);
    await run();
    expect(await rating(v)).toMatchObject({ n_lives: 2, mean: 15 });
    await d1.db
      .prepare("UPDATE lives SET end_tick = 600, score = 60, ended_at = ?2 WHERE id = ?1")
      .bind(alive, T0 + 120_000)
      .run();
    await run();
    expect(await rating(v)).toMatchObject({ n_lives: 3, mean: 30 });
  });
});

describe("idempotency", () => {
  it("counts a life once when the arena writes it twice", async () => {
    const v = await readyBot("a");
    const ids = await addLives(v, [10, 20, 30]);
    await run();
    await addLives(v, [10, 20, 30], { ids });
    expect((await progress())?.assigned_seq).toBe(3);
    await run();
    expect(await rating(v)).toMatchObject({ n_lives: 3, mean: 20 });
  });

  it("counts every life once when the cursor is moved back", async () => {
    const a = await readyBot("a");
    const b = await readyBot("b");
    await addLives(a, scoresOf(120, 10));
    await addLives(b, scoresOf(80, 90));
    await run({ batchLives: 50 });
    const before = [await rating(a), await rating(b)];

    await d1.db.prepare("UPDATE rating_progress SET rated_seq = 0").run();
    await run({ batchLives: 30 });
    expect([await rating(a), await rating(b)]).toEqual(before);
  });

  it("gives the same ratings when runs overlap", async () => {
    const versions = await Promise.all(["a", "b", "c"].map((bot) => readyBot(bot)));
    const all = new Map(versions.map((v, i) => [v, scoresOf(150, 20 * (i + 1), 17 + i)]));
    for (const [v, scores] of all) await addLives(v, scores);

    const results = await Promise.all([
      run({ batchLives: 40 }),
      run({ batchLives: 70 }),
      run({ batchLives: 25 }),
    ]);
    // Each batch was committed by exactly one of them.
    expect(results.reduce((sum, r) => sum + r.lives, 0)).toBeGreaterThanOrEqual(450);
    await run();
    for (const [v, scores] of all) {
      const row = await rating(v);
      expect(row?.n_lives).toBe(150);
      expect(row?.mean).toBeCloseTo(expected(scores).mean, 9);
    }
  });
});

describe("bad scores", () => {
  /** The `ratings.life_skipped` warnings logged so far. */
  function skipped(warn: { mock: { calls: unknown[][] } }) {
    return warn.mock.calls
      .map(([record]) => record as { event: string; lifeId: string; score: string })
      .filter((r) => r.event === "ratings.life_skipped");
  }

  it("skips a score out of range, logs it and keeps the cursor moving", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await readyBot("a");
    const b = await readyBot("b");
    const [, , bad] = await addLives(a, [10, 20, 2e12]);
    await addLives(b, [5, 6, 7]);
    expect(await run()).toMatchObject({ lives: 6, ratedSeq: 6, assignedSeq: 6, more: false });
    expect(await rating(a)).toMatchObject({ n_lives: 2, mean: 15 });
    expect(await rating(b)).toMatchObject({ n_lives: 3, mean: 6 });
    expect(await progress()).toMatchObject({ assigned_seq: 6, rated_seq: 6 });
    expect(skipped(warn)).toEqual([
      expect.objectContaining({ lifeId: bad, score: "2000000000000" }),
    ]);

    // The next run carries on as usual, and so does a rebuild.
    await addLives(a, [30]);
    await run();
    expect(await rating(a)).toMatchObject({ n_lives: 3, mean: 20, life_seq: 7 });
    await d1.db.prepare("UPDATE ratings SET life_seq = NULL").run();
    expect(await run()).toMatchObject({ rebuilt: 2, more: false });
    expect(await rating(a)).toMatchObject({ n_lives: 3, mean: 20, life_seq: 7 });
    expect(await rating(b)).toMatchObject({ n_lives: 3, mean: 6 });
  });

  it("skips bad scores added to a stored rating, and ones that aren't numbers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const v = await readyBot("a");
    await addLives(v, [10, 20]);
    await run();
    await addLives(v, [-5e12, 30]);
    // INTEGER affinity keeps text that isn't a number as text.
    await addLives(v, [0], { ids: ["text-score"] });
    await d1.db.prepare("UPDATE lives SET score = 'lots' WHERE id = 'text-score'").run();
    expect(await run()).toMatchObject({ ratedSeq: 5, more: false });
    expect(await rating(v)).toMatchObject({ n_lives: 3, mean: 20, life_seq: 5 });
    expect(skipped(warn).map((r) => r.score)).toEqual(["-5000000000000", "lots"]);
    expect(await rebuildRatings(d1.db, [v], NOW)).toBe(true);
    expect(await rating(v)).toMatchObject({ n_lives: 3, mean: 20 });
  });
});

describe("stints", () => {
  /** The site's rollback (`activateVersion`): another version active, its rating deleted. */
  async function rollback(bot: string, to: string, at: number) {
    await d1.db.batch([
      d1.db
        .prepare("UPDATE versions SET status = 'archived' WHERE bot_id = ? AND status = 'ready'")
        .bind(bot),
      d1.db
        .prepare("UPDATE versions SET status = 'ready', activated_at = ?2 WHERE id = ?1")
        .bind(to, at),
      d1.db.prepare("DELETE FROM ratings WHERE version_id = ?").bind(to),
    ]);
  }

  async function secondVersion(bot: string) {
    await d1.db
      .prepare(
        `INSERT INTO versions (id, bot_id, n, status, bundle_key, source_key)
         VALUES (?1, ?2, 2, 'validating', 'b.js', 's.json')`,
      )
      .bind(`${bot}-2`, bot)
      .run();
    return `${bot}-2`;
  }

  it("starts over after a rollback, and late lives of the old stint don't come back", async () => {
    const v1 = await readyBot("a");
    const v2 = await secondVersion("a");
    await addLives(v1, scoresOf(40, 1000));
    await run();
    // v2 becomes active (checks pass) and v1 is archived; later the owner rolls back to v1.
    await rollback("a", v2, T0 + 100_000);
    await addLives(v2, [1, 2, 3], { startedAt: T0 + 200_000 });
    const back = T0 + 300_000;
    await rollback("a", v1, back);
    expect(await rating(v1)).toBeNull();

    // A life of v1's first stint the arena writes only now, then lives of the new one.
    await addLives(v1, [9999], { startedAt: T0 + 50_000 });
    await addLives(v1, [10, 30], { startedAt: back + 1000 });
    await run();
    expect(await rating(v1)).toMatchObject({ n_lives: 2, mean: 20, activated_at: back });
    expect(await rating(v2)).toMatchObject({ n_lives: 3, mean: 2 });
    expect(await getLeaderboard(createDb(d1.db))).toEqual([]);
  });

  it("doesn't resurrect a rating when a rollback lands during a run", async () => {
    const v1 = await readyBot("a");
    const v2 = await secondVersion("a");
    await addLives(v1, scoresOf(40, 1000));
    await run();
    await addLives(v1, [5000, 5000]);
    const back = T0 + 500_000;

    // The rollback commits between the job's reads and its write.
    const db = new Proxy(d1.db, {
      get(target, key, receiver) {
        if (key !== "batch") return Reflect.get(target, key, receiver);
        return async (statements: D1PreparedStatement[]) => {
          await rollback("a", v2, back - 1);
          await rollback("a", v1, back);
          return target.batch(statements);
        };
      },
    });
    await updateRatings(db, NOW);
    expect(await rating(v1)).toBeNull();
    // The old stint's lives stay out of the new stint's rating.
    await addLives(v1, [10, 30], { startedAt: back + 1 });
    await run();
    expect(await rating(v1)).toMatchObject({ n_lives: 2, mean: 20, activated_at: back });
  });

  it("counts all lives of a version activated before activated_at existed", async () => {
    const v = await readyBot("a", null);
    await addLives(v, [10, 20], { startedAt: 0 });
    await run();
    expect(await rating(v)).toMatchObject({ n_lives: 2, activated_at: null });
  });
});

describe("rebuilds", () => {
  it("rebuilds ratings marked with life_seq = NULL", async () => {
    const v = await readyBot("a");
    const scores = scoresOf(260, 40, 23);
    await addLives(v, scores);
    await run();
    const good = await rating(v);
    await d1.db
      .prepare("UPDATE ratings SET mean = 0, ci = 0, recent_scores = NULL, life_seq = NULL")
      .run();
    expect(await run()).toMatchObject({ lives: 0, rebuilt: 1, more: false });
    expect(await rating(v)).toEqual({ ...good, life_seq: 260 });
  });

  it("rebuilds rows in the old per-life format, which the old job may write after the migration", async () => {
    const v = await readyBot("a");
    await addLives(v, [10, 20, 30]);
    await run();
    // As the job from before points per minute writes a row: its window, `alive_ticks` left at 0.
    await d1.db
      .prepare(
        `UPDATE ratings SET mean = 20, alive_ticks = 0,
           recent_scores = '{"v":1,"scoring":"raw","scores":[10,20,30]}'`,
      )
      .run();
    expect(await run()).toMatchObject({ rebuilt: 1 });
    expect(await rating(v)).toMatchObject({ n_lives: 3, alive_ticks: 1800, mean: 20 });
    expect(JSON.parse((await rating(v))?.recent_scores ?? "").v).toBe(2);
    // And one it continues: a new life's window is rebuilt, not added to.
    await d1.db
      .prepare(
        `UPDATE ratings SET alive_ticks = 0,
           recent_scores = '{"v":1,"scoring":"raw","scores":[10,20,30]}'`,
      )
      .run();
    await addLives(v, [40]);
    await run();
    expect(await rating(v)).toMatchObject({ n_lives: 4, alive_ticks: 2400, mean: 25 });
  });

  it("rebuilds rows written before the job (no window)", async () => {
    const v = await readyBot("a");
    await addLives(v, [10, 20, 30]);
    await run();
    await d1.db.prepare("UPDATE ratings SET recent_scores = NULL").run();
    await addLives(v, [40]);
    await run();
    expect(await rating(v)).toMatchObject({ n_lives: 4, mean: 25 });
  });

  it("deletes a marked rating with fewer than two counted lives", async () => {
    const v = await readyBot("a");
    await addLives(v, [10, 20]);
    await run();
    await d1.db.prepare("DELETE FROM lives WHERE id = (SELECT min(id) FROM lives)").run();
    await d1.db.prepare("UPDATE ratings SET life_seq = NULL").run();
    await run();
    expect(await rating(v)).toBeNull();
  });

  it("rebuildRatings rebuilds a version up to the cursor", async () => {
    const v = await readyBot("a");
    await addLives(v, [10, 20, 30]);
    await run();
    await d1.db.prepare("UPDATE ratings SET mean = 0").run();
    await addLives(v, [100]); // after the cursor: the next run adds it
    expect(await rebuildRatings(d1.db, [v], NOW)).toBe(true);
    expect(await rating(v)).toMatchObject({ n_lives: 3, mean: 20, life_seq: 3 });
    await run();
    expect(await rating(v)).toMatchObject({ n_lives: 4, mean: 40 });
  });
});

describe("migration 0007", () => {
  const MIGRATION = "0007_rating_job.sql";

  it("numbers existing lives by when they ended and starts the cursor at 0", async () => {
    await d1.dispose();
    d1 = await createTestD1({ migrateBefore: MIGRATION });
    const v = await readyBot("a");
    await d1.db.batch(
      [
        ["late", T0 + 30],
        ["early", T0 + 10],
        ["mid", T0 + 20],
      ].map(([id, ended]) =>
        d1.db
          .prepare(
            `INSERT INTO lives (id, version_id, room, start_tick, end_tick, score, started_at,
               ended_at) VALUES (?1, ?2, 'r', 0, 1, 10, ?3, ?3)`,
          )
          .bind(id, v, ended),
      ),
    );
    await d1.db
      .prepare(
        "INSERT INTO lives (id, version_id, room, start_tick, started_at) VALUES ('alive', ?, 'r', 0, ?)",
      )
      .bind(v, T0)
      .run();
    await applyMigrations(d1.db, undefined, MIGRATION);
    // (Through every later migration: 0014 replays every life into the ratings, bumping `rev`.)

    const { results } = await d1.db
      .prepare("SELECT id, seq FROM lives ORDER BY seq")
      .all<{ id: string; seq: number | null }>();
    expect(results).toEqual([
      { id: "alive", seq: null },
      { id: "early", seq: 1 },
      { id: "mid", seq: 2 },
      { id: "late", seq: 3 },
    ]);
    expect(await progress()).toEqual({ assigned_seq: 3, rated_seq: 0, rev: 1 });
    await addLives(v, [10]);
    expect((await progress())?.assigned_seq).toBe(4);
  });
});

describe("migration 0014", () => {
  const MIGRATION = "0014_long_lives.sql";

  it("deletes the per-life ratings and replays every life into points per minute", async () => {
    await d1.dispose();
    d1 = await createTestD1({ migrateBefore: MIGRATION });
    const v = await readyBot("a");
    // Lives of a minute, half a minute and the old cap (10 minutes), one stopped short of it.
    await addLives(v, [10], { ticks: 600 });
    await addLives(v, [20], { ticks: 300 });
    await addLives(v, [400], { ticks: 6000, deathCause: "retired" });
    await addLives(v, [999], { ticks: 900, deathCause: "retired" });
    // The old job's rating: the mean score per life of the lives it counted.
    await d1.db
      .prepare(
        `INSERT INTO ratings (version_id, activated_at, mean, ci, n_lives, recent_scores, life_seq)
         VALUES (?, ?, 15, 10, 2, '{"v":1,"scoring":"raw","scores":[10,20]}', 4)`,
      )
      .bind(v, T0)
      .run();
    await d1.db.prepare("UPDATE rating_progress SET rated_seq = 4 WHERE id = 1").run();
    await applyMigrations(d1.db, undefined, MIGRATION);

    expect(await rating(v)).toBeNull();
    expect(await progress()).toMatchObject({ assigned_seq: 4, rated_seq: 0 });
    await run();
    // The capped life counts now; the stopped one still doesn't. 430 points in 11.5 minutes.
    const row = await rating(v);
    expect(row).toMatchObject({ n_lives: 3, alive_ticks: 6900, life_seq: 4 });
    expect(row?.mean).toBeCloseTo(430 / 11.5, 9);
  });
});

describe("budget", () => {
  it("rates 10k lives in one run within the cron budget", async () => {
    // 100 versions, 100 lives each, interleaved as rooms write them.
    const versions = 100;
    await d1.db.batch(
      Array.from({ length: versions }, (_, i) => i).flatMap((i) => [
        d1.db
          .prepare("INSERT INTO users (id, name, email) VALUES (?1, ?1, ?1 || '@x.test')")
          .bind(`u${i}`),
        d1.db
          .prepare("INSERT INTO bots (id, owner_id, name, slug) VALUES (?1, ?2, ?1, ?1)")
          .bind(`b${i}`, `u${i}`),
        d1.db
          .prepare(
            `INSERT INTO versions (id, bot_id, n, status, bundle_key, source_key, activated_at)
             VALUES (?1, ?2, 1, 'ready', 'b.js', 's.json', ?3)`,
          )
          .bind(`v${i}`, `b${i}`, T0),
      ]),
    );
    await d1.db
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < 10000)
         INSERT INTO lives (id, version_id, room, start_tick, end_tick, score, death_cause,
           started_at, ended_at)
         SELECT 'l' || i, 'v' || (i % 100), 'r', i, i + 100, (i * 7919) % 1000, 'collision',
           ?1 + i, ?1 + i + 100
         FROM n`,
      )
      .bind(T0)
      .run();

    // Count D1 queries: Workers allow 1000 per invocation.
    let queries = 0;
    const db = new Proxy(d1.db, {
      get(target, key, receiver) {
        if (key === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            return new Proxy(statement, {
              get(s, k) {
                const value = Reflect.get(s, k, s);
                if (k === "bind") {
                  return (...args: unknown[]) => {
                    const bound = (value as (...a: unknown[]) => D1PreparedStatement).apply(
                      s,
                      args,
                    );
                    return new Proxy(bound, {
                      get(b, bk) {
                        const bv = Reflect.get(b, bk, b);
                        if (["all", "first", "run", "raw"].includes(String(bk))) queries++;
                        return typeof bv === "function" ? bv.bind(b) : bv;
                      },
                    });
                  };
                }
                if (["all", "first", "run", "raw"].includes(String(k))) queries++;
                return typeof value === "function" ? value.bind(s) : value;
              },
            });
          };
        }
        if (key === "batch") {
          return (statements: D1PreparedStatement[]) => {
            queries += statements.length;
            return target.batch(statements);
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });

    const cpu = process.cpuUsage();
    const started = performance.now();
    const result = await runRatingJob({ DB: db }, NOW);
    const cpuMs = (process.cpuUsage(cpu).user + process.cpuUsage(cpu).system) / 1000;
    const wallMs = performance.now() - started;

    expect(result).toMatchObject({ lives: 10_000, ratedSeq: 10_000, more: false });
    expect(queries).toBeLessThan(100);
    // The Worker's own CPU (this process; D1 runs in workerd) against the 30 s a Cron Trigger
    // gets, with a wide margin for slow CI machines.
    expect(cpuMs).toBeLessThan(3_000);
    expect(wallMs).toBeLessThan(15_000);
    const scores = Array.from({ length: 100 }, (_, k) => ((k * versions + 7) * 7919) % 1000);
    const row = await rating("v7");
    expect(row?.n_lives).toBe(100);
    expect(row?.mean).toBeCloseTo(expected(scores, 100).mean, 9);
  }, 60_000);
});

describe("Cron Trigger", () => {
  it("is scheduled in wrangler.jsonc, top level and staging", () => {
    const { rawConfig } = readRawConfig({
      config: join(import.meta.dirname, "../../wrangler.jsonc"),
    });
    expect(rawConfig.triggers?.crons).toContain(RATINGS_CRON);
    expect(rawConfig.env?.staging?.triggers?.crons).toContain(RATINGS_CRON);
  });

  it("logs the run and never throws", async () => {
    const result = await runRatingJob({ DB: d1.db }, NOW);
    expect(result).toMatchObject({ lives: 0, more: false });
    const failed = await runRatingJob(
      {
        DB: {
          prepare: () => {
            throw new Error("D1 down");
          },
        } as unknown as D1Database,
      },
      NOW,
    );
    expect(failed).toBeNull();
  });
});
