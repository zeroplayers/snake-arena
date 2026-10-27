import { afterEach, describe, expect, it } from "vitest";
import { DAY_MS, type MatchmakerConfig } from "./matchmaker/config.ts";
import type { MatchmakerStatus, TickReport } from "./matchmaker.ts";
import type { LifeDrop, LifeResult, LifeTicket, RoomStatus } from "./protocol.ts";
import { EVICTIONS_TO_QUARANTINE } from "./room/backstop.ts";
import { BOTS, createHarness, type Harness } from "./testing/harness.ts";
import type { FakeLife, FakeStep } from "./testing/matchmaker-worker.ts";

let h: Harness | null = null;

afterEach(async () => {
  await h?.dispose();
  h = null;
});

/** A fresh workerd with the real matchmaker and `FakeRoom`s (or real rooms). */
async function setup(
  config: Partial<MatchmakerConfig> = {},
  rooms: "FakeRoom" | "RoomDO" = "FakeRoom",
): Promise<Harness> {
  h = await createHarness({
    worker: "matchmaker-worker.ts",
    rooms,
    matchmaker: "TestMatchmakerDO",
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
});
