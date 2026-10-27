import { houseBots } from "@zerosnake/house-bots";
import { describe, expect, it } from "vitest";
import { playMatch, type RoomTrace } from "./match.ts";
import { batchTicks, DEFAULT_MAX_SNAKES, DEFAULT_MIN_AUTHORS, houseFill } from "./room-rules.ts";

interface Batch {
  tick: number;
  ticks: number;
  bots: number;
  starts: number;
  spawns: { id: string; author: string }[];
  /** Authors alive when the batch was planned. */
  present: string[];
}

/** Plays a match with `easy` in the candidate's seat and records the room process. */
function record(seed: number) {
  const batches: Batch[] = [];
  const alive = new Map<string, string>();
  const trace: RoomTrace = {
    batch: (e) => batches.push({ ...e, spawns: [], present: [...alive.values()] }),
    spawn: (e) => {
      const b = batches.at(-1) as Batch;
      expect(e.tick, `${e.id} spawned between batches`).toBe(b.tick);
      expect([...alive.values()], `${e.author} has two snakes`).not.toContain(e.author);
      alive.set(e.id, e.author);
      b.spawns.push({ id: e.id, author: e.author });
    },
    death: (e) => alive.delete(e.id),
  };
  const result = playMatch(
    { kind: "house", bot: houseBots.easy },
    { seed, ticks: 1000, opBudget: 10 },
    trace,
  );
  return { batches, result };
}

describe("a check room runs by RoomDO's rules", () => {
  it.each([1, 2, 3, 4, 5, 6])("seed %i: batches, joins and house fill", (seed) => {
    const { batches, result } = record(seed);
    expect(result.ticks).toBe(1000);
    expect(batches.length).toBeGreaterThan(5);
    for (const [k, b] of batches.entries()) {
      // Batch size from the arena's formula, and the next batch starts where this one ended.
      expect(b.ticks).toBe(batchTicks(b.bots, b.starts));
      expect(b.starts).toBe(b.spawns.length);
      expect(b.bots).toBe(b.present.length + b.starts);
      const next = batches[k + 1];
      if (next) expect(next.tick).toBe(b.tick + b.ticks);

      // Tickets (deployed bots: UUID authors) first, then exactly what the house fill adds.
      const tickets = b.spawns.filter((s) => !s.author.startsWith("house:"));
      const house = b.spawns.slice(tickets.length);
      expect(b.spawns.slice(0, tickets.length)).toEqual(tickets);
      const expected = houseFill(
        [...b.present, ...tickets.map((t) => t.author)].map((author) => ({ author })),
        DEFAULT_MAX_SNAKES,
        DEFAULT_MIN_AUTHORS,
        b.tick,
      );
      expect(house).toEqual(expected.map((h) => ({ id: h.lifeId, author: h.author })));
    }
  });

  it("varies its start, pre-roll, and the mix of house bots and deployed bots", () => {
    const rooms = [11, 12, 13, 14, 15, 16, 17, 18].map((seed) => record(seed).batches);
    const starts = rooms.map((b) => b[0]?.tick as number);
    const tickets = new Set(
      rooms.map((b) => b[0]?.spawns.filter((s) => !s.author.startsWith("house:")).length),
    );
    // Young rooms open at tick 0, like every RoomDO; older ones anywhere past 1000.
    expect(starts).toContain(0);
    expect(new Set(starts.filter((t) => t >= 1000)).size).toBeGreaterThan(1);
    expect(tickets.size).toBeGreaterThan(1);
  });
});
