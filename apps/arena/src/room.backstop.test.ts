import { describe, expect, it } from "vitest";
import type { QuarantineRecord, RoomStatus } from "./protocol.ts";
import { KILLS_TO_EVICT, ROOM_KILLS_TO_EVICT } from "./room/backstop.ts";
import { BOTS } from "./testing/harness.ts";
import {
  advance,
  drive,
  events,
  evictedLives,
  evictionKills,
  h,
  house,
  lifeRow,
  limits,
  outcomes,
  spares,
  startQuietRoom,
  ticket,
  useRoomHarness,
} from "./testing/room-tests.ts";

// The backstop's tests wait out wall-clock kills, so they're split over three files that run in
// parallel: bots that burn by themselves (here), after many ticks of memory, and rooms restarted
// under honest or slow bots.
useRoomHarness();

describe("RoomDO backstop", () => {
  it("evicts a bot that blows the CPU limit by itself and quarantines it on its second life", async () => {
    const evil = await ticket("mallory", BOTS.hostile(120));
    const others = await Promise.all([
      ticket("kate", house.hard as string),
      ticket("liam", house.medium as string),
    ]);
    // Short replay chunks, so the evicted life's chunk reaches R2 within the test.
    await startQuietRoom("backstop", [evil, ...others], { limits: { ...limits, chunkTicks: 100 } });
    // Its next lives, for when the first is evicted (a third in case the second dies of something
    // else before it burns).
    for (const n of [2, 3]) {
      await h.call("matchmaker", "offer", { ...evil, lifeId: `life-mallory-${n}` }, "backstop");
    }
    await spares("backstop", 3);

    // A normal batch dies (nobody to name), then every watched rerun dies in its call.
    const first = await drive("backstop", (s) => s.evictions.length > 0, { max: 200 });
    expect(first.kills).toBe(1 + KILLS_TO_EVICT);
    expect(outcomes(first.s)).toEqual(["overrun", ...evictionKills]);
    expect(first.s.evictions).toEqual([
      { versionId: evil.versionId, lifeId: evil.lifeId, tick: 120 },
    ]);
    expect(first.s.quarantined).toEqual([]);
    // Neutral: no strike, no ban, no D1 row; the matchmaker hears `evicted`.
    const next = await h.room<RoomStatus>("backstop", "runBatch");
    expect(next.snakes.map((x) => x.lifeId)).not.toContain(evil.lifeId);

    // Its second life does it again (still watched): evicted at once, and quarantined.
    const second = await drive("backstop", (s) => s.quarantined.length > 0, { max: 200 });
    expect(second.kills).toBe(KILLS_TO_EVICT);
    const [, again] = second.s.evictions.map((x) => x.lifeId);
    expect(second.s.evictions).toHaveLength(2);
    expect(["life-mallory-2", "life-mallory-3"]).toContain(again);
    expect(second.s.quarantined).toEqual([evil.versionId]);
    expect(
      await h.room("backstop", "join", { ...evil, lifeId: "evil-3", author: "mallory2" }),
    ).toEqual({ ok: false, reason: "quarantined" });

    // The room goes on with the others.
    let s = await advance("backstop", 50);
    expect(s.snakes.map((x) => x.lifeId)).not.toContain(again);
    expect(s.incidents).toHaveLength(1 + 2 * KILLS_TO_EVICT);

    // Like any life, the matchmaker hears of it once its replay chunk is in R2; D1 gets no row.
    for (let i = 0; i < 100 && !(await evictedLives()).some((l) => l.lifeId === evil.lifeId); i++) {
      s = await h.room<RoomStatus>("backstop", "runBatch");
    }
    expect((await evictedLives()).find((l) => l.lifeId === evil.lifeId)).toMatchObject({
      versionId: evil.versionId,
      endTick: expect.any(Number),
    });
    expect(await lifeRow(evil.lifeId)).toBeNull();
    const db = await h.d1();
    const version = await db
      .prepare(
        "SELECT status, quarantined_at, quarantine_reason, change_seq FROM versions WHERE id = ?",
      )
      .bind(evil.versionId)
      .first<{
        status: string;
        quarantined_at: number | null;
        quarantine_reason: string | null;
        change_seq: number;
      }>();
    // Quarantine isn't a ban: still `ready`, marked for every room and the matchmaker's poll.
    expect(version?.status).toBe("ready");
    expect(version?.quarantined_at).toEqual(expect.any(Number));
    expect(version?.quarantine_reason).toContain("Quarantined by the arena for review");
    const latest = await db
      .prepare("SELECT max(change_seq) AS m FROM versions")
      .first<{ m: number }>();
    expect(version?.change_seq).toBe(latest?.m);
    // Another room refuses it too.
    await h.room("backstop-elsewhere", "start", { roomId: "backstop-elsewhere", manual: true });
    expect(
      await h.room("backstop-elsewhere", "join", { ...evil, lifeId: "evil-4", author: "mal3" }),
    ).toEqual({ ok: false, reason: "quarantined" });
    const quarantine = (await events()).find((e) => e.kind === "versionQuarantined");
    expect(quarantine?.body as QuarantineRecord).toMatchObject({
      versionId: evil.versionId,
      lifeId: again,
      evictions: 2,
    });
  }, 240_000);

  it("evicts and quarantines a bot that only burns next to its real neighbours", async () => {
    // The reviewer's case: reruns of the room replay its neighbours exactly (every bot restarts
    // at the saved frame), so it burns again on every attempt.
    const fickle = await ticket("uma", BOTS.neighbours);
    const others = await Promise.all([
      ticket("vic", house.hard as string),
      ticket("wes", house.medium as string),
    ]);
    await startQuietRoom("neighbours", [fickle, ...others], { limits });
    await h.call("matchmaker", "offer", { ...fickle, lifeId: "life-uma-2" }, "neighbours");
    await spares("neighbours", 3);

    const { kills, s } = await drive("neighbours", (s) => s.quarantined.length > 0, { max: 300 });
    expect(kills).toBe(1 + 2 * KILLS_TO_EVICT);
    expect(s.evictions.map((x) => x.lifeId)).toEqual([fickle.lifeId, "life-uma-2"]);
    expect(s.quarantined).toEqual([fickle.versionId]);

    // And the room makes progress.
    const after = await advance("neighbours", 100);
    expect(after.incidents).toHaveLength(kills);
    expect(after.snakes.map((x) => x.lifeId)).not.toContain("life-uma-2");
  }, 240_000);

  it("evicts colluders that take turns being named, within the room's cap of kills", async () => {
    // Three versions, each burning 20 ticks after every restart, but only on room ticks whose
    // residue mod 3 is its turn. A kill restarts all bots at the room's last saved frame, which
    // has moved on 20 ticks, so the kills name them in turn: a streak of kills naming one life
    // never started. The window counts them anyway, and its cap evicts all three.
    const colluders = await Promise.all(
      [0, 1, 2].map((turn) => ticket(`col${turn}`, BOTS.turns(turn, 3, 20))),
    );
    const others = await Promise.all([
      ticket("xena", house.hard as string),
      ticket("yuri", house.medium as string),
    ]);
    // Short batches, so the frame moves on between kills.
    await startQuietRoom("colluders", [...colluders, ...others], {
      limits: { ...limits, batchTicks: 5 },
    });
    await spares("colluders", 3);

    const ids = colluders.map((c) => c.lifeId);
    const { kills, s } = await drive(
      "colluders",
      (s) => ids.every((id) => s.evictions.some((e) => e.lifeId === id)),
      { max: 300 },
    );
    // One unwatched kill, then at most the room's cap (plus a second round for one never named).
    expect(kills).toBeGreaterThan(KILLS_TO_EVICT);
    expect(kills).toBeLessThanOrEqual(1 + ROOM_KILLS_TO_EVICT + KILLS_TO_EVICT);
    expect(s.evictions.map((e) => e.lifeId).sort()).toEqual([...ids].sort());
    // More than one of them was named (the old streak would never have evicted any).
    const named = new Set(s.incidents.map((i) => i.versionId).filter((v) => v !== null));
    expect(named.size).toBeGreaterThan(1);
    expect(s.incidents.every((i) => !others.some((o) => o.versionId === i.versionId))).toBe(true);

    const after = await advance("colluders", 100);
    expect(after.incidents).toHaveLength(kills);
  }, 600_000);
});
