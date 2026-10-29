import { describe, expect, it } from "vitest";
import type { RoomStatus } from "./protocol.ts";
import { VERSION_KILLS_TO_QUARANTINE } from "./room/backstop.ts";
import { BOTS } from "./testing/harness.ts";
import {
  advance,
  drive,
  evictedLives,
  evictionKills,
  h,
  house,
  limits,
  outcomes,
  sleep,
  spares,
  startQuietRoom,
  ticket,
  useRoomHarness,
} from "./testing/room-tests.ts";

// The backstop under restarts, honest bots and slow calls (see `room.backstop.test.ts`).
useRoomHarness();

describe("RoomDO backstop", () => {
  it("names a call that runs past the room's budget and returns, so the room can't stall", async () => {
    // The reviewer's probe: CPU limit 10 s, room budget 1 s, a bot spinning ~2.5 s in every tick.
    // Watch mode never lets it reach the CPU limit, but each of its calls runs past the abort
    // share; that used to abandon the tick and rerun it forever, naming nobody.
    const spinner = await ticket("sven", BOTS.slow(2500));
    const others = await Promise.all([
      ticket("tess", house.hard as string),
      ticket("ugo", house.medium as string),
    ]);
    await startQuietRoom("spinner", [spinner, ...others], {
      limits: { cpuLimitMs: 10_000, cpuBudgetMs: 1000, batchTicks: 50 },
    });
    await h.call("matchmaker", "offer", { ...spinner, lifeId: "life-sven-2" }, "spinner");
    await spares("spinner", 3);

    // The first (normal) batch runs until it is killed, late enough to count as the CPU limit;
    // after that, each watched batch names the spinner's call and ends.
    const { kills, s } = await drive("spinner", (s) => s.quarantined.length > 0, {
      hangMs: 12_000,
      max: 60,
    });
    expect(kills).toBe(1);
    expect(outcomes(s)).toEqual(["overrun", ...evictionKills, ...evictionKills]);
    expect(s.evictions.map((x) => x.lifeId)).toEqual([spinner.lifeId, "life-sven-2"]);
    expect(s.quarantined).toEqual([spinner.versionId]);
    expect(
      s.incidents.every((i) => i.versionId === null || i.versionId === spinner.versionId),
    ).toBe(true);

    // And the room makes progress.
    const after = await advance("spinner", 100);
    expect(after.incidents).toHaveLength(s.incidents.length);
    expect(after.snakes.map((x) => x.lifeId)).not.toContain("life-sven-2");
  }, 300_000);

  it("never evicts or quarantines honest bots, however often the room is restarted", async () => {
    // The reviewer's repro: five honest versions, 40 restarts 0-300 ms into a batch, each
    // recovered after 1.5 s (longer than this room's CPU limit, so every crash looks like the
    // CPU limit, and timing can't spare anyone).
    // Each version has a bundle of its own, and instrumenting one takes 150 ms longer, as on a
    // slow CI machine: every restart lands while the room instruments them again, so this fails
    // if that's timed as the bots' `init`.
    const honest = await Promise.all(
      ["h5", "h6", "h7", "h8", "h9"].map((a) => ticket(a, `${house.hard}\n// ${a}\n`)),
    );
    await startQuietRoom("storm", honest, { limits });
    await h.room("storm", "slowInstrument", 150);
    await h.room("storm", "runBatch");
    for (let i = 0; i < 40; i++) {
      void h.fire("storm", "runBatch");
      await sleep((i * 97) % 301);
      await h.restart();
      await sleep(1500);
    }
    const s = await h.room<RoomStatus>("storm", "runBatch");
    expect(s.incidents.filter((i) => i.outcome !== "restart").length).toBeGreaterThan(20);
    expect(s.evictions).toEqual([]);
    expect(s.quarantined).toEqual([]);
    // The kills that named them went to D1 too, and were retracted with the room's tally.
    const db = await h.d1();
    const ids = honest.map((t) => t.versionId);
    const marks = ids.map(() => "?").join(", ");
    const counted = await db
      .prepare(
        `SELECT version_id, sum(retracted = 0) AS n FROM version_kills
         WHERE version_id IN (${marks}) GROUP BY version_id`,
      )
      .bind(...ids)
      .all<{ version_id: string; n: number }>();
    for (const c of counted.results) expect(c.n).toBeLessThan(VERSION_KILLS_TO_QUARANTINE);
    const quarantined = await db
      .prepare(`SELECT id FROM versions WHERE quarantined_at IS NOT NULL AND id IN (${marks})`)
      .bind(...ids)
      .all();
    expect(quarantined.results).toEqual([]);
    const evicted = await evictedLives();
    expect(evicted.filter((l) => honest.some((t) => t.lifeId === l.lifeId))).toEqual([]);
    // The room goes on.
    await spares("storm", 2);
    await advance("storm", 100);
  }, 300_000);

  it("counts nothing when the room is restarted twice in a row (no CPU-limit evidence)", async () => {
    // Default 30 s CPU limit; a slow but honest bot just makes the batch long enough to interrupt.
    const slowpoke = await ticket("pia", BOTS.slow(30));
    const tom = await ticket("tom", house.hard as string);
    await startQuietRoom("restarts", [slowpoke, tom], { limits: { batchTicks: 50 } });
    for (let i = 0; i < 2; i++) {
      void h.fire("restarts", "runBatch");
      await sleep(800);
      await h.restart();
    }
    const s = await h.room<RoomStatus>("restarts", "runBatch");
    expect(outcomes(s)).toEqual(["restart", "restart"]);
    expect(s.evictions).toEqual([]);
    expect(s.kills).toEqual([]);
    expect(s.watching).toBe(false);
    expect(s.tick).toBe(50);
    expect(s.snakes.map((x) => x.lifeId)).toEqual(
      expect.arrayContaining([slowpoke.lifeId, tom.lifeId]),
    );
  }, 60_000);

  it("doesn't punish a bot for being slow: watch mode keeps the room going", async () => {
    // Slow every tick (~150 ms the meter doesn't see), so a normal batch overruns in aggregate.
    // Only the sandbox's meter may strike a bot; watch mode just keeps each invocation short.
    const slow = await ticket("quentin", BOTS.slow(150));
    const honest = await Promise.all([
      ticket("ruth", house.hard as string),
      ticket("sam", house.medium as string),
    ]);
    await startQuietRoom("slow", [slow, ...honest], {
      limits: { cpuLimitMs: 2000, batchTicks: 50 },
    });
    const { kills, s } = await drive("slow", (s) => s.tick >= 80, { hangMs: 4000, max: 200 });
    expect(kills).toBe(1);
    expect(outcomes(s)).toEqual(["overrun"]);
    expect(s.watching).toBe(true);
    expect(s.evictions).toEqual([]);
    expect(s.snakes.map((x) => x.lifeId)).toContain(slow.lifeId);
  }, 180_000);
});
