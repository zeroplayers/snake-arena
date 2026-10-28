import { describe, expect, it } from "vitest";
import type { RoomStatus } from "./protocol.ts";
import { KILLS_TO_EVICT, VERSION_KILLS_TO_QUARANTINE } from "./room/backstop.ts";
import { BOTS } from "./testing/harness.ts";
import {
  advance,
  drive,
  evictionKills,
  h,
  house,
  limits,
  outcomes,
  spares,
  startRoom,
  ticket,
  useRoomHarness,
} from "./testing/room-tests.ts";

// The backstop with bots that burn only after many ticks of memory (see `room.backstop.test.ts`).
useRoomHarness();

describe("RoomDO backstop", () => {
  it("evicts a bot that only burns after many ticks of memory (restarts put it off)", async () => {
    // Each kill restarts it with empty memory, but it is the one named every time.
    const burner = await ticket("nina", BOTS.burnAfter(60));
    const other = await ticket("oscar", house.hard as string);
    await startRoom("burner", [burner, other], { limits });
    const { kills, s } = await drive("burner", (s) => s.evictions.length > 0, { max: 300 });
    expect(kills).toBe(1 + KILLS_TO_EVICT);
    expect(outcomes(s)).toEqual(["overrun", ...evictionKills]);
    expect(s.evictions.map((x) => x.lifeId)).toEqual([burner.lifeId]);
    // The evicted snake dies at the start of the next batch, without running again.
    const next = await h.room<RoomStatus>("burner", "runBatch");
    expect(next.snakes.map((x) => x.lifeId)).toContain(other.lifeId);
    expect(next.snakes.map((x) => x.lifeId)).not.toContain(burner.lifeId);
  }, 240_000);

  it("quarantines a bot that burns too rarely for the kill window to evict it", async () => {
    // The reviewer's periodic burner, scaled down: it burns once its memory has seen 60 ticks,
    // and a kill leaves the window after 100 ticks of progress (production: 1600 and 3000, see
    // `backstop.test.ts`). Every kill restarts it with no memory, so its kills land ~60 ticks
    // apart and the window never holds three. Its version's tally counts them all.
    const periodic = await ticket("pete", BOTS.burnAfter(60));
    const other = await ticket("rosa", house.hard as string);
    // Batches of 5 ticks, so each kill restarts it at most 5 ticks before its burn.
    await startRoom("periodic", [periodic, other], {
      limits: { ...limits, batchTicks: 5, killWindowTicks: 100 },
    });
    // More lives of the same version, in case one dies of something else between its burns: the
    // tally counts the version's kills across lives.
    for (const n of [2, 3]) {
      await h.call("matchmaker", "offer", { ...periodic, lifeId: `life-pete-${n}` }, "periodic");
    }
    await spares("periodic", 2);
    const { kills, s } = await drive("periodic", (s) => s.quarantined.length > 0, { max: 600 });
    // One unwatched kill names nobody; every watched one names it.
    expect(kills).toBe(1 + VERSION_KILLS_TO_QUARANTINE);
    const named = Array(VERSION_KILLS_TO_QUARANTINE - 1).fill("suspect");
    expect(outcomes(s)).toEqual(["overrun", ...named, "evicted"]);
    expect(s.kills.length).toBeLessThan(KILLS_TO_EVICT);
    expect(s.versionKills.map((k) => k.versionId)).toEqual(
      Array(VERSION_KILLS_TO_QUARANTINE).fill(periodic.versionId),
    );
    expect(s.evictions.map((x) => x.versionId)).toEqual([periodic.versionId]);
    expect(s.quarantined).toEqual([periodic.versionId]);

    // D1 has the same kills, which would quarantine it however its lives were spread over rooms.
    const after = await advance("periodic", 20);
    expect(after.incidents).toHaveLength(kills);
    const db = await h.d1();
    const rows = await db
      .prepare("SELECT room, retracted FROM version_kills WHERE version_id = ?")
      .bind(periodic.versionId)
      .all<{ room: string; retracted: number }>();
    expect(rows.results).toEqual(
      Array(VERSION_KILLS_TO_QUARANTINE).fill({ room: "periodic", retracted: 0 }),
    );
    const version = await db
      .prepare("SELECT quarantined_at FROM versions WHERE id = ?")
      .bind(periodic.versionId)
      .first<{ quarantined_at: number | null }>();
    expect(version?.quarantined_at).toEqual(expect.any(Number));
  }, 300_000);
});
