import { DELETE_ACCOUNT_STATEMENTS, deleteAccountParams, PURGE_SQL } from "@zerosnake/web/shared";
import { afterEach, describe, expect, it } from "vitest";
import { insertLives } from "./db.ts";
import { DAY_MS, type MatchmakerConfig } from "./matchmaker/config.ts";
import type { MatchmakerStatus, TickReport } from "./matchmaker.ts";
import type { LifeDrop, LifeResult, LifeTicket, RoomStatus } from "./protocol.ts";
import { EVICTIONS_TO_QUARANTINE } from "./room/backstop.ts";
import { BOTS, createHarness, type Harness } from "./testing/harness.ts";
import type { FakeLife, FakeStep } from "./testing/matchmaker-worker.ts";
import { type DataPoint, metricsNamed } from "./testing/metrics.ts";

let h: Harness | null = null;

afterEach(async () => {
  await h?.dispose();
  h = null;
});

/** A fresh workerd with the real matchmaker and `FakeRoom`s (or real rooms). */
async function setup(
  config: Partial<MatchmakerConfig> = {},
  rooms: "FakeRoom" | "RoomDO" = "FakeRoom",
  metrics?: "record",
): Promise<Harness> {
  h = await createHarness({
    worker: "matchmaker-worker.ts",
    rooms,
    matchmaker: "TestMatchmakerDO",
    ...(metrics && { metrics }),
  });
  await mm("configure", config);
  return h;
}

function harness(): Harness {
  if (!h) throw new Error("no harness");
  return h;
}

const mm = <T = unknown>(method: string, ...args: unknown[]) =>
  harness().call<T>("matchmaker", method, ...args);
const room = <T = unknown>(name: string, method: string, ...args: unknown[]) =>
  harness().room<T>(name, method, ...args);
const status = () => mm<MatchmakerStatus>("status");
const query = <T = Record<string, unknown>>(sql: string, ...args: unknown[]) =>
  mm<T[]>("query", sql, ...args);

/** Ticks until the matchmaker has nothing left over. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) if (!(await mm<TickReport>("tick")).more) return;
  throw new Error("matchmaker never settled");
}

async function openRooms(): Promise<string[]> {
  return (await status()).rooms.filter((r) => r.state === "open").map((r) => r.roomId);
}

const step = (name: string, options: object = {}) => room<FakeStep>(name, "step", options);
const lives = (name: string) => room<FakeLife[]>(name, "lives");

interface BotSpec {
  author: string;
  bot: string;
  /** Versions 1..n; version 1 is `ready`, the others `archived`. Default 1. */
  versions?: number;
}

const versionId = (bot: string, n = 1) => `${bot}-v${n}`;

/** Users, bots and versions in D1, and their bundles in R2. */
async function seedBots(specs: BotSpec[], source = BOTS.circler): Promise<void> {
  const db = await harness().d1();
  const bundles = await harness().r2("BUNDLES");
  const statements: D1PreparedStatement[] = [];
  const keys: string[] = [];
  for (const { author, bot, versions = 1 } of specs) {
    statements.push(
      db
        .prepare("INSERT OR IGNORE INTO users (id, name, email) VALUES (?, ?, ?)")
        .bind(author, author, `${author}@example.com`),
      db
        .prepare("INSERT INTO bots (id, owner_id, name, slug) VALUES (?, ?, ?, ?)")
        .bind(bot, author, bot, bot),
    );
    for (let n = 1; n <= versions; n++) {
      const key = `bundles/${versionId(bot, n)}.js`;
      keys.push(key);
      statements.push(
        db
          .prepare(
            `INSERT INTO versions (id, bot_id, n, status, bundle_key, source_key)
             VALUES (?, ?, ?, ?, ?, 's')`,
          )
          .bind(versionId(bot, n), bot, n, n === 1 ? "ready" : "archived", key),
      );
    }
  }
  await db.batch(statements);
  for (let i = 0; i < keys.length; i += 10) {
    await Promise.all(keys.slice(i, i + 10).map((k) => bundles.put(k, source)));
  }
}

async function d1(sql: string, ...args: unknown[]): Promise<void> {
  const db = await harness().d1();
  await db
    .prepare(sql)
    .bind(...args)
    .run();
}

/** A finished life as a room reports it. */
function ended(ticket: LifeTicket, roomId: string, deathCause: LifeResult["deathCause"]) {
  const now = Date.now();
  return {
    lifeId: ticket.lifeId,
    versionId: ticket.versionId,
    author: ticket.author,
    roomId,
    startTick: 0,
    endTick: 50,
    score: 1,
    lengthMax: 10,
    kills: 0,
    deathCause,
    killer: null,
    replayKey: `${roomId}/0.zsr`,
    startedAt: now,
    endedAt: now,
  } satisfies LifeResult;
}

const nextLife = (roomId: string, excludeAuthors: string[] = []) =>
  mm<LifeTicket | null>("nextLife", { roomId, excludeAuthors });

async function mustLife(roomId: string, excludeAuthors: string[] = []): Promise<LifeTicket> {
  const ticket = await nextLife(roomId, excludeAuthors);
  if (!ticket) throw new Error(`no life for ${roomId}`);
  return ticket;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The ledger's row of a life. */
async function ledger(
  lifeId: string,
): Promise<{ state: string; cause: string | null; leave: number }> {
  const [row] = await query<{ state: string; cause: string | null; leave: number }>(
    "SELECT state, cause, leave FROM lives WHERE life_id = ?",
    lifeId,
  );
  if (!row) throw new Error(`no ledger row for ${lifeId}`);
  return row;
}

async function quarantinedAt(id: string): Promise<number | null> {
  const db = await harness().d1();
  const row = await db
    .prepare("SELECT quarantined_at FROM versions WHERE id = ?")
    .bind(id)
    .first<{ quarantined_at: number | null }>();
  return row?.quarantined_at ?? null;
}

/** Lives the ledger counts toward each bot's quota (issued, ended, lost; not dropped). */
async function counted(): Promise<Map<string, number>> {
  const rows = await query<{ bot_id: string; n: number }>(
    `SELECT b.bot_id, count(l.life_id) AS n FROM bots b
     LEFT JOIN lives l ON l.bot_id = b.bot_id AND l.state != 'dropped' GROUP BY b.bot_id`,
  );
  return new Map(rows.map((r) => [r.bot_id, r.n]));
}

describe("MatchmakerDO", () => {
  it("200 bots: the right number of rooms, one snake per author, exact quotas", async () => {
    await setup({ openThreshold: 10, maxSnakes: 20, livesPerBotPerDay: 3 });
    // 80 authors with 2 or 3 bots each. (Bots first queue in id order: padded, every room's 20
    // are distinct authors, so all 200 fit 10 rooms.)
    const specs = Array.from({ length: 200 }, (_, i) => ({
      author: `a${i % 80}`,
      bot: `b${String(i).padStart(3, "0")}`,
    }));
    await seedBots(specs);
    await settle();

    let s = await status();
    expect(s.playable).toBe(200);
    // Enough rooms to bring the queue down to the threshold: ceil((200 - 10) / 20).
    const opened = await openRooms();
    expect(opened).toHaveLength(10);
    expect(s.issued).toBe(200);
    expect(s.waiting).toBe(0);
    for (const r of opened) {
      const held = await lives(r);
      expect(held).toHaveLength(20);
      expect(new Set(held.map((l) => l.author)).size).toBe(20);
    }

    // Lives die and are replaced (lifeEnded redelivered every other round) until every bot used
    // its quota: rooms empty out and close.
    let maxOpen = 0;
    for (let round = 0; round < 60; round++) {
      const open = await openRooms();
      maxOpen = Math.max(maxOpen, open.length);
      if (open.length === 0) break;
      for (const r of open) await step(r, { deaths: 7, redeliver: round % 2 === 0 });
      await settle();
    }
    s = await status();
    expect(maxOpen).toBe(10);
    expect(s.rooms.map((r) => r.state)).toEqual(Array(10).fill("closed"));
    expect(s.issued).toBe(0);
    expect(s.waiting).toBe(0);
    const used = await counted();
    expect(used.size).toBe(200);
    expect([...used.values()].every((n) => n === 3)).toBe(true);
    const states = await query<{ state: string; n: number }>(
      "SELECT state, count(*) AS n FROM lives GROUP BY state",
    );
    expect(states).toEqual([{ state: "ended", n: 600 }]);
    for (const r of opened) expect(await room(r, "violations")).toEqual([]);
  }, 120_000);

  // One room of 10 for 30 bots. With 10 authors of 3 bots each, a bot whose author is in the
  // room waits (keeping its place) while bots behind it go first, so turns are off by one more.
  it.each([
    { authors: 30, spread: 1 },
    { authors: 10, spread: 2 },
  ])(
    "takes turns: $authors authors, no bot more than $spread lives ahead",
    async ({ authors, spread }) => {
      await setup({ openThreshold: 100, maxSnakes: 10 });
      await seedBots(
        Array.from({ length: 30 }, (_, i) => ({ author: `a${i % authors}`, bot: `b${i}` })),
      );
      await settle();
      const [r] = await openRooms();
      if (!r) throw new Error("no room");
      expect(await openRooms()).toHaveLength(1);
      for (let round = 0; round < 20; round++) {
        await step(r, { deaths: 3 });
        const n = [...(await counted()).values()];
        expect(n).toHaveLength(30);
        expect(Math.max(...n) - Math.min(...n)).toBeLessThanOrEqual(spread);
      }
      expect([...(await counted()).values()].reduce((a, b) => a + b)).toBe(70);
      expect(await room(r, "violations")).toEqual([]);
    },
    60_000,
  );

  it("follows bans, quarantines, rollbacks and archives, and retires the lives in rooms", async () => {
    await setup({ openThreshold: 5 });
    const names = ["ban", "quarantine", "rollback", "archive", "userban", "steady"];
    await seedBots(
      names.map((n) => ({ author: `u-${n}`, bot: n, versions: 2 })),
      BOTS.circler,
    );
    await settle();
    const [r] = await openRooms();
    if (!r) throw new Error("no room");
    expect((await lives(r)).map((l) => l.versionId).sort()).toEqual(
      names.map((n) => versionId(n)).sort(),
    );

    // What the site does for each (one D1 transaction each; change_seq follows).
    await d1("UPDATE versions SET status = 'rejected' WHERE id = ?", versionId("ban"));
    await d1(
      "UPDATE versions SET quarantined_at = 1, quarantine_reason = 'cpu' WHERE id = ?",
      versionId("quarantine"),
    );
    await d1("UPDATE versions SET status = 'archived' WHERE id = ?", versionId("rollback"));
    await d1("UPDATE versions SET status = 'ready' WHERE id = ?", versionId("rollback", 2));
    await d1("UPDATE bots SET archived_at = 1 WHERE id = 'archive'");
    await d1("UPDATE versions SET status = 'archived' WHERE id = ?", versionId("archive"));
    await d1("UPDATE users SET banned_at = 1 WHERE id = 'u-userban'");
    await d1("UPDATE versions SET status = 'archived' WHERE id = ?", versionId("userban"));
    // The site's hint runs the poll at once.
    await mm("activeVersionChanged", {
      v: 1,
      botId: "rollback",
      ownerId: "u-rollback",
      reason: "activate",
      versionId: versionId("rollback", 2),
      previousVersionId: versionId("rollback"),
      changedAt: Date.now(),
    });
    const leaving = (await lives(r)).filter((l) => l.leaving).map((l) => l.versionId);
    expect(leaving.sort()).toEqual(
      ["archive", "ban", "quarantine", "rollback", "userban"].map((n) => versionId(n)),
    );
    const { joined } = await step(r);
    expect(joined.map((t) => t.versionId)).toEqual([versionId("rollback", 2)]);
    expect((await lives(r)).map((l) => l.versionId).sort()).toEqual(
      [versionId("steady"), versionId("rollback", 2)].sort(),
    );
    expect((await status()).playable).toBe(2);

    // An admin lifts the quarantine: the bot plays again.
    await d1("UPDATE versions SET quarantined_at = NULL WHERE id = ?", versionId("quarantine"));
    await settle();
    expect((await step(r)).joined.map((t) => t.versionId)).toEqual([versionId("quarantine")]);
  }, 60_000);

  it("a bot or user ban alone stops its versions at the next poll", async () => {
    // No full reconcile: only the `change_seq` poll can see the bans.
    await setup({ openThreshold: 2, reconcileMs: DAY_MS });
    await seedBots([
      { author: "u-bot", bot: "botban" },
      { author: "u-user", bot: "userban" },
      { author: "u-user", bot: "userban2" },
      { author: "u-steady", bot: "steady" },
    ]);
    await settle();
    const [r] = await openRooms();
    if (!r) throw new Error("no room");
    // One snake per author: one of u-user's bots plays, the other waits.
    const playing = (await lives(r)).map((l) => l.versionId);
    expect(playing).toHaveLength(3);
    const userLife = playing.find((v) => v.startsWith("userban"));
    if (!userLife) throw new Error("no u-user life");

    // Only `banned_at` changes (no version status), and no hint from the site.
    await d1("UPDATE bots SET banned_at = 1 WHERE id = 'botban'");
    await d1("UPDATE users SET banned_at = 1 WHERE id = 'u-user'");
    await mm("tick");
    const leaving = (await lives(r)).filter((l) => l.leaving).map((l) => l.versionId);
    expect(leaving.sort()).toEqual([versionId("botban"), userLife].sort());
    expect((await step(r)).joined).toEqual([]);
    expect((await lives(r)).map((l) => l.versionId)).toEqual([versionId("steady")]);
    expect((await status()).playable).toBe(1);

    // Unbanned: both of u-user's bots may play again.
    await d1("UPDATE users SET banned_at = NULL WHERE id = 'u-user'");
    await mm("tick");
    expect((await status()).playable).toBe(3);
  }, 60_000);

  it("a deleted account's bots stop at the next poll, and a late life of theirs is dropped", async () => {
    await setup({ openThreshold: 2, reconcileMs: DAY_MS });
    await seedBots([
      { author: "u-gone", bot: "gone" },
      { author: "u-gone", bot: "gone2" },
      { author: "u-a", bot: "a" },
      { author: "u-b", bot: "b" },
    ]);
    await settle();
    const [r] = await openRooms();
    if (!r) throw new Error("no room");
    const goneLife = (await lives(r)).find((l) => l.author === "u-gone");
    if (!goneLife) throw new Error("no u-gone life");

    // Step 1 of the deletion, exactly as the site runs it, and no hint from the site.
    const db = await harness().d1();
    const at = Date.now();
    await db.batch(
      DELETE_ACCOUNT_STATEMENTS.map((s) =>
        db.prepare(s).bind(...deleteAccountParams(s, "u-gone", at)),
      ),
    );
    await mm("tick");
    const leaving = (await lives(r)).filter((l) => l.leaving).map((l) => l.versionId);
    expect(leaving).toEqual([goneLife.versionId]);
    expect((await step(r)).joined).toEqual([]);
    expect((await status()).playable).toBe(2);

    // Step 2 erases the rows. The room reports the retired life only now: dropped, not an error.
    const ids = JSON.stringify([versionId("gone"), versionId("gone2")]);
    await db.prepare(PURGE_SQL.deleteVersions).bind(ids).run();
    await db.prepare(PURGE_SQL.deleteUser).bind("u-gone").run();
    const late = ended(
      { lifeId: goneLife.lifeId, versionId: goneLife.versionId, author: "u-gone", source: "queue" },
      r,
      "retired",
    );
    await insertLives(db, [late]);
    const row = await db.prepare("SELECT id FROM lives WHERE id = ?").bind(goneLife.lifeId).first();
    expect(row).toBeNull();
    await mm("lifeEnded", late);
    await mm("tick");
    expect((await status()).playable).toBe(2);
    expect((await step(r)).joined.map((t) => t.author)).not.toContain("u-gone");
  }, 60_000);

  it("a quarantine reported by a room, or found when issuing, stops the version at once", async () => {
    await setup({ openThreshold: 0 });
    await seedBots([
      { author: "x", bot: "x" },
      { author: "y", bot: "y" },
    ]);
    await settle();
    const [r] = await openRooms();
    if (!r) throw new Error("no room");
    const x = (await lives(r)).find((l) => l.author === "x");
    await mm("versionQuarantined", {
      versionId: versionId("x"),
      author: "x",
      lifeId: x?.lifeId,
      roomId: "elsewhere",
      tick: 1,
      evictions: 2,
      kills: 0,
      message: "q",
      at: Date.now(),
    });
    await settle();
    expect((await lives(r)).find((l) => l.author === "x")?.leaving).toBe(true);
    await step(r);
    expect((await lives(r)).map((l) => l.author)).toEqual(["y"]);

    // Quarantined in D1 since the last poll: `nextLife` checks before issuing, so when y's life
    // ends the room gets nothing, and closes.
    await d1("UPDATE versions SET quarantined_at = 1 WHERE id = ?", versionId("y"));
    expect(await step(r, { deaths: 1 })).toMatchObject({ joined: [], state: "closed" });
    expect((await counted()).get("y")).toBe(1);
    expect((await status()).playable).toBe(0);
  }, 60_000);

  it("the arena stop switch retires every life, closes rooms and opens none until resumed", async () => {
    await setup({ openThreshold: 5, maxSnakes: 10 });
    await seedBots(Array.from({ length: 25 }, (_, i) => ({ author: `a${i}`, bot: `b${i}` })));
    await settle();
    const rooms = await openRooms();
    expect(rooms).toHaveLength(2);

    await d1("UPDATE arena_control SET paused = 1, reason = 'test' WHERE id = 1");
    const control = {
      v: 1,
      paused: true,
      deploysPaused: false,
      reason: "test",
      deploysReason: null,
      updatedAt: Date.now(),
    };
    await mm("arenaControlChanged", control);
    for (const r of rooms) expect((await lives(r)).every((l) => l.leaving)).toBe(true);
    for (const r of rooms) expect((await step(r)).state).toBe("closed");
    await settle();
    let s = await status();
    expect(s.paused).toBe(true);
    expect(s.issued).toBe(0);
    expect(s.waiting).toBe(25);
    expect(await openRooms()).toEqual([]);
    expect(await nextLife("any")).toBeNull();
    // Retired lives count toward the quota: they ran.
    expect([...(await counted()).values()].reduce((a, b) => a + b)).toBe(20);

    await d1("UPDATE arena_control SET paused = 0 WHERE id = 1");
    await mm("arenaControlChanged", { ...control, paused: false });
    await settle();
    s = await status();
    expect(s.paused).toBe(false);
    expect(await openRooms()).toHaveLength(2);
    expect(s.issued).toBe(20);
  }, 60_000);

  it("lifeEnded and lifeDropped are idempotent; quotas are exact per UTC day", async () => {
    await setup({ livesPerBotPerDay: 2 });
    await seedBots([{ author: "solo", bot: "solo" }]);
    await settle();
    // No room open: it opens one (FakeRoom) with the bot's first life.
    const [r] = await openRooms();
    if (!r) throw new Error("no room");
    const [first] = await lives(r);
    if (!first) throw new Error("no life");
    const ticket1 = { ...first, source: "" };
    await room(r, "forget", first.lifeId);

    const result = ended(ticket1, r, "collision");
    for (let i = 0; i < 3; i++) await mm("lifeEnded", result);
    expect((await counted()).get("solo")).toBe(1);

    const second = await nextLife(r);
    if (!second) throw new Error("no second life");
    expect(await nextLife(r)).toBeNull(); // one life at a time
    const drop: LifeDrop = {
      lifeId: second.lifeId,
      versionId: second.versionId,
      roomId: r,
      reason: "full",
      at: Date.now(),
    };
    await mm("lifeDropped", drop);
    await mm("lifeDropped", drop);
    expect((await counted()).get("solo")).toBe(1);

    const third = await nextLife(r);
    if (!third) throw new Error("no third life");
    await mm("lifeEnded", ended(third, r, "wall"));
    await mm("lifeEnded", ended(third, r, "wall"));
    // A late duplicate of the first doesn't free anything or count again.
    await mm("lifeEnded", result);
    expect((await counted()).get("solo")).toBe(2);
    expect(await nextLife(r)).toBeNull(); // quota used up today

    await mm("advance", DAY_MS);
    const fourth = await nextLife(r);
    expect(fourth?.versionId).toBe(versionId("solo"));
  }, 60_000);

  it("seeds today's usage from D1 on its first start", async () => {
    // No rooms of its own: the test asks for lives as a room would.
    await setup({ livesPerBotPerDay: 3, maxRooms: 0 });
    await seedBots([{ author: "old", bot: "old" }]);
    const now = Date.now();
    for (const id of ["l1", "l2"]) {
      await d1(
        `INSERT INTO lives (id, version_id, room, start_tick, end_tick, death_cause, started_at, ended_at)
         VALUES (?, ?, 'r', 0, 10, 'wall', ?, ?)`,
        id,
        versionId("old"),
        now,
        now,
      );
    }
    await settle();
    const t = await nextLife("r");
    if (!t) throw new Error("no life");
    await mm("lifeEnded", ended(t, "r", "wall"));
    expect(await nextLife("r")).toBeNull();
  }, 60_000);

  it("quarantines a version whose lives were evicted in different rooms", async () => {
    await setup({ maxRooms: 0 });
    await seedBots([
      { author: "burner", bot: "burner" },
      { author: "fine", bot: "fine" },
    ]);
    await settle();
    for (let i = 0; i < EVICTIONS_TO_QUARANTINE; i++) {
      const t = await nextLife(`room-${i}`, ["fine"]);
      if (!t) throw new Error("no life");
      expect(t.author).toBe("burner");
      // Redelivered: still one eviction.
      await mm("lifeEnded", ended(t, `room-${i}`, "evicted"));
      await mm("lifeEnded", ended(t, `room-${i}`, "evicted"));
    }
    const db = await harness().d1();
    const row = await db
      .prepare("SELECT quarantined_at, quarantine_reason FROM versions WHERE id = ?")
      .bind(versionId("burner"))
      .first<{ quarantined_at: number | null; quarantine_reason: string }>();
    expect(row?.quarantined_at).not.toBeNull();
    expect(row?.quarantine_reason).toContain(
      `evicted ${EVICTIONS_TO_QUARANTINE} of this bot's lives`,
    );
    expect(await nextLife("room-x", ["fine"])).toBeNull();
    expect((await nextLife("room-x"))?.author).toBe("fine");
  }, 60_000);

  it("recovers after an eviction mid-way, and frees bots whose lives got lost", async () => {
    await setup({ openThreshold: 5, maxSnakes: 10, roomsPerAlarm: 1, roomCheckMs: 0 });
    await seedBots(Array.from({ length: 40 }, (_, i) => ({ author: `a${i}`, bot: `b${i}` })));
    await mm("tick");
    await mm("tick");
    expect(await openRooms()).toHaveLength(2);
    // Memory gone, storage kept.
    await harness().restart();
    await settle();
    const rooms = await openRooms();
    expect(rooms).toHaveLength(4);
    let s = await status();
    expect(s.issued).toBe(40);
    expect([...(await counted()).values()].every((n) => n === 1)).toBe(true);
    const held = new Set<string>();
    for (const r of rooms) for (const l of await lives(r)) held.add(l.lifeId);
    expect(held.size).toBe(40);

    // A room loses a life without a report: after `lostAfterMs` its bot gets the next one.
    const [r0] = rooms;
    if (!r0) throw new Error("no room");
    const [gone] = await lives(r0);
    if (!gone) throw new Error("no life");
    await room(r0, "forget", gone.lifeId);
    await settle();
    expect((await status()).issued).toBe(40);
    // The rooms keep ticking, so the lives they hold stay held.
    for (const r of rooms) await step(r);
    await mm("advance", 31 * 60_000);
    await settle();
    s = await status();
    expect(s.issued).toBe(39);
    expect(s.waiting).toBe(1);
    const [lost] = await query<{ state: string }>(
      "SELECT state FROM lives WHERE life_id = ?",
      gone.lifeId,
    );
    expect(lost?.state).toBe("lost");
    const { joined } = await step(r0);
    expect(joined.map((t) => t.author)).toEqual([gone.author]);
    // The lost life still counts: it may have run.
    expect((await counted()).get(`b${gone.author.slice(1)}`)).toBe(2);
  }, 60_000);

  it("never loses a life its room still holds, however long it lives", async () => {
    await setup({ openThreshold: 0, roomCheckMs: 0 });
    await seedBots([{ author: "long", bot: "long" }]);
    await settle();
    const [r0] = await openRooms();
    if (!r0) throw new Error("no room");
    const [life] = await lives(r0);
    if (!life) throw new Error("no life");
    // A life lasts until the snake dies (up to 24 hours of game time): hours after it was issued
    // the room still holds it, and its bot keeps it.
    for (let hour = 0; hour < 6; hour++) {
      await step(r0); // the room keeps ticking
      await mm("advance", 60 * 60_000);
      await settle();
    }
    expect((await status()).issued).toBe(1);
    // It ends, and its report never comes: lost `lostAfterMs` after the room last held it, not
    // at once (it was issued six hours ago).
    await room(r0, "forget", life.lifeId);
    await settle();
    const state = async () =>
      (await query<{ state: string }>("SELECT state FROM lives WHERE life_id = ?", life.lifeId))[0]
        ?.state;
    expect(await state()).toBe("issued");
    await mm("advance", 31 * 60_000);
    await settle();
    expect(await state()).toBe("lost");
  }, 60_000);

  it("frees the bots of a room stuck on their lives, and stops counting them as in flight", async () => {
    await setup({ openThreshold: 0, roomCheckMs: 0 });
    await seedBots([{ author: "stuck", bot: "stuck" }]);
    await settle();
    const [r0] = await openRooms();
    if (!r0) throw new Error("no room");
    const [life] = await lives(r0);
    if (!life) throw new Error("no life");
    const db = await harness().d1();
    const beat = () =>
      db
        .prepare("SELECT lives_in_flight FROM arena_heartbeat WHERE id = 1")
        .first<number>("lives_in_flight");
    expect(await beat()).toBe(1);
    // The room answers `status()` and still holds the life, but its tick stands still (outbox
    // full, alarms failing): no progress, so the life stops counting as held and in flight.
    await mm("advance", 61_000);
    await settle();
    await mm("advance", 61_000);
    await settle();
    expect(await beat()).toBe(0);
    const state = async () =>
      (await query<{ state: string }>("SELECT state FROM lives WHERE life_id = ?", life.lifeId))[0]
        ?.state;
    expect(await state()).toBe("issued");
    await mm("advance", 31 * 60_000);
    await settle();
    expect(await state()).toBe("lost");
    expect((await status()).waiting).toBe(1);
  }, 60_000);

  it("keeps a slow room's life to the cap however long it takes, and retires one past it", async () => {
    await setup({ openThreshold: 0, roomCheckMs: 0 });
    await seedBots([{ author: "forever", bot: "forever" }]);
    await settle();
    const [r0] = await openRooms();
    if (!r0) throw new Error("no room");
    const [life] = await lives(r0);
    if (!life) throw new Error("no life");
    // A slow room (heavy bots): 14 100 ticks an hour of wall time, about 4 per second. Two days
    // in, its life is still well under the cap (864 000 ticks); past 61 hours it is over it.
    for (let hour = 0; hour < 64; hour++) {
      await room(r0, "advanceTicks", 14_000);
      await step(r0);
      await mm("advance", 60 * 60_000);
      await settle();
      if (hour === 47) {
        // Two days of wall time, 676 800 ticks old: a healthy life on its way to the cap.
        expect((await lives(r0)).find((l) => l.lifeId === life.lifeId)?.leaving).toBe(false);
        expect((await status()).issued).toBe(1);
      }
      if ((await lives(r0)).find((l) => l.lifeId === life.lifeId)?.leaving) {
        // Retired once its room reported it past the cap (874 200 ticks at 62 hours), the leave
        // reaching the room by the next check: not at 48 hours of wall time.
        expect(hour).toBe(62);
        break;
      }
    }
    // Asked to leave: the room retires it at its next batch, and the bot is freed by the report.
    expect((await lives(r0)).find((l) => l.lifeId === life.lifeId)?.leaving).toBe(true);
    const { ended } = await step(r0);
    expect(ended).toContain(life.lifeId);
  }, 60_000);

  it("asks again for a leave that reached the room before the ticket did", async () => {
    await setup({ maxRooms: 0 });
    await seedBots([{ author: "late", bot: "late" }]);
    await settle();
    await room("r1", "start", { roomId: "r1" });
    const t = await mustLife("r1");
    // Archived while the room still checks the ticket (before `join` completes): the room
    // doesn't hold it yet and says so.
    await d1("UPDATE versions SET status = 'archived' WHERE id = ?", versionId("late"));
    await settle();
    expect(await ledger(t.lifeId)).toMatchObject({ state: "issued", leave: 1 });
    expect(await room("r1", "join", t)).toEqual({ ok: true });
    // The retry (after its backoff) reaches the room, which now holds it.
    await mm("advance", 2_000);
    await settle();
    expect(await lives("r1")).toMatchObject([{ lifeId: t.lifeId, leaving: true }]);
    expect((await ledger(t.lifeId)).leave).toBe(2);
    await step("r1");
    expect(await ledger(t.lifeId)).toMatchObject({ state: "ended", cause: "retired" });
    // Settled: nothing more to ask.
    await mm("advance", 120_000);
    expect((await mm<TickReport>("tick")).more).toBe(false);
  }, 60_000);

  it("a lifted quarantine isn't put back by old evictions, which age out", async () => {
    await setup({ maxRooms: 0, livesPerBotPerDay: 100 });
    await seedBots([{ author: "burner", bot: "burner" }]);
    await settle();
    const id = versionId("burner");
    /** Evicts a new life of the bot, `offset` ms into the matchmaker's clock. */
    const evict = async (roomId: string, offset = 0) => {
      const result = ended(await mustLife(roomId), roomId, "evicted");
      result.endedAt += offset;
      await mm("lifeEnded", result);
      return result;
    };
    const first: LifeResult[] = [];
    for (let i = 0; i < EVICTIONS_TO_QUARANTINE; i++) first.push(await evict(`room-${i}`));
    expect(await quarantinedAt(id)).not.toBeNull();

    // An admin lifts it. Redelivered reports of the evictions that led to it don't put it back.
    await d1(
      "UPDATE versions SET quarantined_at = NULL, quarantine_reason = NULL WHERE id = ?",
      id,
    );
    await settle();
    for (const r of first) await mm("lifeEnded", r);
    expect(await quarantinedAt(id)).toBeNull();
    // The count starts afresh: one new eviction isn't enough.
    await evict("room-a");
    expect(await quarantinedAt(id)).toBeNull();

    // A week on, that one aged out (and was forgotten): one more still isn't enough...
    const week = 8 * DAY_MS;
    await mm("advance", week);
    await settle();
    expect(await query("SELECT life_id FROM evictions")).toEqual([]);
    await evict("room-b", week);
    expect(await quarantinedAt(id)).toBeNull();
    // ...but two within the window are.
    await evict("room-c", week);
    expect(await quarantinedAt(id)).not.toBeNull();
  }, 60_000);

  it("a deploy or a rollback keeps the bot's place in the queue", async () => {
    await setup({ maxRooms: 0 });
    await seedBots([
      { author: "a", bot: "a" },
      { author: "b", bot: "b", versions: 2 },
      { author: "c", bot: "c" },
    ]);
    await settle();
    // a's turn: the queue is then b, c, a.
    const t = await mustLife("r");
    expect(t.author).toBe("a");
    await mm("lifeEnded", ended(t, "r", "wall"));
    // b deploys: the site archives v1, and the poll may see that before v2 is ready.
    await d1("UPDATE versions SET status = 'archived' WHERE id = ?", versionId("b"));
    await settle();
    expect((await status()).playable).toBe(2);
    await d1("UPDATE versions SET status = 'ready' WHERE id = ?", versionId("b", 2));
    await settle();
    expect((await mustLife("r")).versionId).toBe(versionId("b", 2));
    expect((await mustLife("r2", ["b"])).author).toBe("c");
  }, 60_000);

  it("starts no room without a fresh read of the stop switch, and none if it can't be read", async () => {
    // The switch as read stays cached for an hour, unless the matchmaker reads it before a start.
    await setup({ openThreshold: 0, maxSnakes: 2, arenaControlPollMs: 3_600_000 });
    await settle();
    // A room whose start failed earlier, to be retried.
    await query("INSERT INTO rooms (room_id, state, opened_at) VALUES ('stuck', 'opening', 0)");
    await d1("ALTER TABLE arena_control RENAME TO arena_control_away");
    await seedBots(Array.from({ length: 4 }, (_, i) => ({ author: `a${i}`, bot: `b${i}` })));
    await settle();
    expect((await status()).waiting).toBe(4);
    expect(await openRooms()).toEqual([]);
    expect(await room<RoomStatus>("stuck", "status")).toMatchObject({ state: "new" });

    // Readable again (and not stopped): the retry and a new room start.
    await d1("ALTER TABLE arena_control_away RENAME TO arena_control");
    await settle();
    expect(await openRooms()).toHaveLength(2);
    expect(await lives("stuck")).toHaveLength(2);

    // Stopped without the site's hint, while the cached answer says running: more lives wait,
    // and the read before starting a room for them finds the switch on.
    await d1("UPDATE arena_control SET paused = 1, reason = 'test' WHERE id = 1");
    await seedBots([{ author: "a9", bot: "b9" }]);
    await settle();
    await mm("tick");
    const s = await status();
    expect(s.paused).toBe(true);
    expect(s.rooms.filter((r) => r.state !== "closed")).toHaveLength(2);
    expect((await lives("stuck")).every((l) => l.leaving)).toBe(true);
  }, 60_000);
});

describe("MatchmakerDO with real rooms", () => {
  it("a ticket a room never spawned is reported dropped and gives the quota back", async () => {
    await setup({ room: { manual: true, limits: { batchTicks: 5 } } }, "RoomDO");
    await seedBots([{ author: "ann", bot: "ann" }]);
    await settle();
    const [r] = await openRooms();
    if (!r) throw new Error("no room");
    expect((await room<RoomStatus>(r, "status")).pending).toHaveLength(1);
    expect((await counted()).get("ann")).toBe(1);

    // Archived before the room's first batch: the matchmaker asks the room to retire the life,
    // which drops the ticket and reports it with its next batch.
    await d1("UPDATE versions SET status = 'archived' WHERE id = ?", versionId("ann"));
    await settle();
    const s = await room<RoomStatus>(r, "runBatch");
    expect(s.pending).toEqual([]);
    expect(s.state).toBe("closed");
    const [life] = await query<{ state: string }>("SELECT state FROM lives");
    expect(life?.state).toBe("dropped");
    expect((await counted()).get("ann")).toBe(0);
    expect((await status()).rooms).toEqual([{ roomId: r, state: "closed", lives: 0 }]);
  }, 60_000);

  it("opens a room, keeps it fed until the quotas run out, and the room closes", async () => {
    await setup(
      {
        livesPerBotPerDay: 2,
        room: { manual: true, limits: { batchTicks: 20, chunkTicks: 40 } },
      },
      "RoomDO",
    );
    const authors = ["ann", "bob", "cid", "dee", "eve", "fay"];
    await seedBots(
      authors.map((a) => ({ author: a, bot: a })),
      BOTS.thrower,
    );
    await settle();
    expect(await openRooms()).toHaveLength(1);
    // Rooms run batches the way their alarms would. With fewer bots than a room holds, a room
    // can close when all its snakes died before their reports (sent once their replay chunk is
    // in R2) put the bots back in the queue: the matchmaker then opens another.
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const open = await openRooms();
      for (const r of open) {
        seen.add(r);
        await room<RoomStatus>(r, "runBatch");
      }
      await settle();
      if (open.length === 0 && (await status()).issued === 0) break;
    }
    for (const r of seen) expect((await room<RoomStatus>(r, "status")).state).toBe("closed");
    const db = await harness().d1();
    const rows = await db
      .prepare("SELECT version_id, death_cause FROM lives ORDER BY version_id")
      .all<{ version_id: string; death_cause: string }>();
    expect(rows.results).toHaveLength(12);
    expect(rows.results.every((l) => l.death_cause === "error")).toBe(true);
    const m = await status();
    expect(m.rooms.map((x) => [x.state, x.lives])).toEqual([...seen].map(() => ["closed", 0]));
    expect(m.issued).toBe(0);
    expect([...(await counted()).values()]).toEqual(Array(6).fill(2));
  }, 120_000);

  it("below the threshold, waiting lives take house bots' slots instead of opening rooms", async () => {
    await setup(
      { openThreshold: 5, maxSnakes: 3, room: { manual: true, limits: { batchTicks: 5 } } },
      "RoomDO",
    );
    await seedBots([{ author: "ann", bot: "ann" }]);
    await settle();
    const [r] = await openRooms();
    if (!r) throw new Error("no room");
    // Two more bots wait: not enough to open a room while one is open.
    await seedBots([
      { author: "bob", bot: "bob" },
      { author: "cid", bot: "cid" },
    ]);
    await settle();
    expect(await openRooms()).toEqual([r]);
    expect((await status()).waiting).toBe(2);

    // The room runs full (Ann and two house bots), yet asks for them: house slots count as free.
    const s1 = await room<RoomStatus>(r, "runBatch");
    expect(s1.snakes.map((x) => x.house ?? x.author).sort()).toEqual(["ann", "easy", "medium"]);
    expect(s1.pending).toHaveLength(2);
    expect((await status()).waiting).toBe(0);
    // Both house bots make way at the next batch.
    const s2 = await room<RoomStatus>(r, "runBatch");
    expect(s2.snakes.map((x) => x.author).sort()).toEqual(["ann", "bob", "cid"]);
    await settle();
    expect(await openRooms()).toEqual([r]);
  }, 60_000);

  it("a lone bot plays all its lives in one room", async () => {
    await setup(
      { livesPerBotPerDay: 4, room: { manual: true, limits: { batchTicks: 20, chunkTicks: 40 } } },
      "RoomDO",
    );
    await seedBots([{ author: "solo", bot: "solo" }], BOTS.thrower);
    await settle();
    const [r] = await openRooms();
    if (!r) throw new Error("no room");
    // Each life ends long before its report (sent once its replay chunk is in R2): the room waits
    // for it instead of closing, and gets the bot's next life.
    for (let i = 0; i < 40; i++) {
      const s = await room<RoomStatus>(r, "runBatch");
      await settle();
      if (s.state === "closed") break;
    }
    expect((await status()).rooms).toEqual([{ roomId: r, state: "closed", lives: 0 }]);
    expect((await counted()).get("solo")).toBe(4);
    const db = await harness().d1();
    const rows = await db.prepare("SELECT room FROM lives").all<{ room: string }>();
    expect(rows.results.map((x) => x.room)).toEqual(Array(4).fill(r));
  }, 120_000);

  it("a leave while the room's batch spawns the ticket retires the life, not drops it", async () => {
    await setup({ room: { manual: true, limits: { batchTicks: 5, chunkTicks: 10 } } }, "RoomDO");
    await seedBots([{ author: "ann", bot: "ann" }]);
    await settle();
    const [r] = await openRooms();
    if (!r) throw new Error("no room");
    const [lifeId] = (await room<RoomStatus>(r, "status")).pending;
    if (!lifeId) throw new Error("no ticket");
    // The batch that spawns it takes a while (instrumenting its bundle), and the version is
    // archived meanwhile.
    await room(r, "slowInstrument", 3_000);
    const batch = room<RoomStatus>(r, "runBatch");
    await sleep(500);
    await d1("UPDATE versions SET status = 'archived' WHERE id = ?", versionId("ann"));
    await settle();
    // The room said it can't yet (dropping the ticket would report a life about to run).
    expect((await ledger(lifeId)).leave).toBe(1);
    expect((await batch).snakes.map((x) => x.lifeId)).toContain(lifeId);
    // It runs, so it isn't dropped: the matchmaker's retry retires it.
    expect((await ledger(lifeId)).state).toBe("issued");
    await mm("advance", 2_000);
    await settle();
    expect((await ledger(lifeId)).leave).toBe(2);
    for (let i = 0; i < 10 && (await ledger(lifeId)).state === "issued"; i++) {
      await room(r, "runBatch");
    }
    expect(await ledger(lifeId)).toMatchObject({ state: "ended", cause: "retired" });
    expect((await counted()).get("ann")).toBe(1);
  }, 120_000);
});

describe("MatchmakerDO metrics", () => {
  const points = () => mm<DataPoint[]>("metricPoints");

  it("writes arena.gauge once a minute and room.stalled for a room whose tick stands still", async () => {
    await setup({ livesPerBotPerDay: 1 }, "FakeRoom", "record");
    await seedBots(["ann", "bob", "cid"].map((a) => ({ author: a, bot: a })));
    await settle();
    const [roomId] = await openRooms();
    if (!roomId) throw new Error("no room");
    // One, though settling ran the alarm's work several times within the minute. A life counts
    // toward the quota once issued, so with one a day every bot is out of quota already.
    expect(metricsNamed(await points(), "arena.gauge")).toEqual([
      { rooms: 1, liveSnakes: 3, queuedLives: 0, readyVersions: 3, exhausted: 3, paused: 0 },
    ]);

    // Every life ends, and nothing waits: the room closes.
    expect((await step(roomId, { deaths: 3 })).state).toBe("closed");
    await mm("advance", 61_000);
    await mm("tick");
    expect(metricsNamed(await points(), "arena.gauge").at(-1)).toEqual({
      rooms: 0,
      liveSnakes: 0,
      queuedLives: 0,
      readyVersions: 3,
      exhausted: 3,
      paused: 0,
    });
    expect(metricsNamed(await points(), "room.stalled")).toEqual([]);
  }, 60_000);

  it("reports a running room whose tick doesn't move between checks", async () => {
    await setup({}, "FakeRoom", "record");
    await seedBots(["ann", "bob"].map((a) => ({ author: a, bot: a })));
    await settle();
    const [roomId] = await openRooms();
    if (!roomId) throw new Error("no room");
    expect(metricsNamed(await points(), "arena.gauge").at(-1)).toMatchObject({
      rooms: 1,
      liveSnakes: 2,
      readyVersions: 2,
    });
    // Settling checked the room (tick 0). It moves (a batch), then stands still.
    await step(roomId);
    await mm("advance", 61_000);
    await mm("tick");
    expect(metricsNamed(await points(), "room.stalled")).toEqual([]);
    await mm("advance", 61_000);
    await mm("tick");
    expect(metricsNamed(await points(), "room.stalled")).toEqual([
      { roomId, reason: "no_progress", tick: 100, stalledMs: expect.any(Number), outbox: 0 },
    ]);
    const [stalled] = metricsNamed(await points(), "room.stalled");
    expect(stalled?.stalledMs).toBeGreaterThanOrEqual(60_000);
    // Moving again: no more reports.
    await step(roomId);
    await mm("advance", 61_000);
    await mm("tick");
    expect(metricsNamed(await points(), "room.stalled")).toHaveLength(1);
  }, 60_000);

  it("writes version.quarantined when evictions across rooms quarantine a version", async () => {
    await setup({ maxRooms: 0 }, "FakeRoom", "record");
    await seedBots([
      { author: "burner", bot: "burner" },
      { author: "fine", bot: "fine" },
    ]);
    await settle();
    for (let i = 0; i < EVICTIONS_TO_QUARANTINE; i++) {
      const t = await mustLife(`room-${i}`, ["fine"]);
      await mm("lifeEnded", ended(t, `room-${i}`, "evicted"));
    }
    expect(metricsNamed(await points(), "version.quarantined")).toEqual([
      {
        versionId: versionId("burner"),
        by: "matchmaker",
        roomId: `room-${EVICTIONS_TO_QUARANTINE - 1}`,
        evictions: EVICTIONS_TO_QUARANTINE,
        kills: 0,
      },
    ]);
  }, 60_000);
});
