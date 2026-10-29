import { houseBots } from "@zerosnake/house-bots";
import { describe, expect, it } from "vitest";
import { playMatch, type RoomTrace } from "./match.ts";
import { batchTicks, DEFAULT_MAX_SNAKES, houseFill } from "./room-rules.ts";

interface Batch {
  tick: number;
  ticks: number;
  bots: number;
  starts: number;
  spawns: { id: string; author: string }[];
  /** Snakes alive when the batch was planned (id → author). */
  present: Map<string, string>;
  /** House snakes retired to make way for tickets. */
  retired: string[];
  /** Snakes that died on the batch's first tick. */
  firstTickDeaths: string[];
}

/** Plays a match with `easy` in the candidate's seat and records the room process. */
function record(seed: number) {
  const batches: Batch[] = [];
  const alive = new Map<string, string>();
  const trace: RoomTrace = {
    batch: (e) => batches.push({ ...e, spawns: [], present: new Map(alive), firstTickDeaths: [] }),
    spawn: (e) => {
      const b = batches.at(-1) as Batch;
      expect(e.tick, `${e.id} spawned between batches`).toBe(b.tick);
      expect([...alive.values()], `${e.author} has two snakes`).not.toContain(e.author);
      alive.set(e.id, e.author);
      b.spawns.push({ id: e.id, author: e.author });
    },
    death: (e) => {
      const b = batches.at(-1) as Batch;
      if (e.tick === b.tick + 1) b.firstTickDeaths.push(e.id);
      alive.delete(e.id);
    },
  };
  const result = playMatch(
    { kind: "house", bot: houseBots.easy },
    { seed, ticks: 1000, opBudget: 10 },
    trace,
  );
  return { batches, result };
}

describe("a check room runs by RoomDO's rules", () => {
  it.each([1, 2, 3, 4, 5, 6])(
    "seed %i: batches, joins and house fill",
    (seed) => {
      const { batches, result } = record(seed);
      expect(result.ticks).toBe(1000);
      expect(batches.length).toBeGreaterThan(5);
      for (const [k, b] of batches.entries()) {
        // Batch size from the arena's formula, and the next batch starts where this one ended.
        expect(b.ticks).toBe(batchTicks(b.bots, b.starts));
        expect(b.starts).toBe(b.spawns.length);
        expect(b.bots).toBe(b.present.size - b.retired.length + b.starts);
        const next = batches[k + 1];
        if (next) expect(next.tick).toBe(b.tick + b.ticks);

        // Tickets (deployed bots: UUID authors) first, then exactly what the house fill adds.
        const isHouse = (author: string) => author.startsWith("house:");
        const tickets = b.spawns.filter((s) => !isHouse(s.author));
        const house = b.spawns.slice(tickets.length);
        expect(b.spawns.slice(0, tickets.length)).toEqual(tickets);
        // House snakes make way for tickets beyond the room's size, and die on the first tick.
        const over = b.present.size + tickets.length - DEFAULT_MAX_SNAKES;
        expect(b.retired).toHaveLength(Math.max(0, over));
        for (const id of b.retired) {
          expect(isHouse(b.present.get(id) ?? "")).toBe(true);
          expect(b.firstTickDeaths).toContain(id);
        }
        const staying = [...b.present].filter(([id]) => !b.retired.includes(id));
        const expected = houseFill(
          [...staying.map(([, a]) => a), ...tickets.map((t) => t.author)].map((author) => ({
            author,
          })),
          DEFAULT_MAX_SNAKES,
          b.tick,
        );
        expect(house).toEqual(expected.map((h) => ({ id: h.lifeId, author: h.author })));
        // Every batch runs the room full.
        expect(b.bots).toBe(DEFAULT_MAX_SNAKES);
      }
    },
    60_000,
  );

  // Full rooms: 20 snakes a tick, 8 matches of 1000 ticks (~10 s under load).
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
  }, 60_000);
});
