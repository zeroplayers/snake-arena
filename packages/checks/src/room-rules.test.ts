import { describe, expect, it } from "vitest";
import { batchTicks, houseFill, houseToRetire } from "./room-rules.ts";

// Pins the port of RoomDO's rules (apps/arena/src/room/house.ts and limits.ts, PR #56). If the
// arena changes them, these must change with it, or a check room becomes recognisable.
describe("houseFill", () => {
  it("fills every free slot in fill order, numbering the spawns of one tick", () => {
    const fill = houseFill([{ author: "u1" }], 20, 1234);
    expect(fill).toHaveLength(19);
    expect(fill.slice(0, 5)).toEqual([
      { lifeId: "house-medium-1234-0", author: "house:medium", house: "medium" },
      { lifeId: "house-easy-1234-1", author: "house:easy", house: "easy" },
      { lifeId: "house-hard-1234-2", author: "house:hard", house: "hard" },
      { lifeId: "house-chaos-1234-3", author: "house:chaos", house: "chaos" },
      { lifeId: "house-medium-1234-4", author: "house:medium#2", house: "medium" },
    ]);
  });

  it("takes the kinds the room has fewest of; names a second copy by its author, not its id", () => {
    expect(houseFill([{ author: "house:medium" }, { author: "u1" }], 6, 7)).toEqual([
      { lifeId: "house-easy-7-0", author: "house:easy", house: "easy" },
      { lifeId: "house-hard-7-1", author: "house:hard", house: "hard" },
      { lifeId: "house-chaos-7-2", author: "house:chaos", house: "chaos" },
      { lifeId: "house-medium-7-3", author: "house:medium#2", house: "medium" },
    ]);
    expect(houseFill([], 6, 0).map((h) => h.author)).toEqual([
      "house:medium",
      "house:easy",
      "house:hard",
      "house:chaos",
      "house:medium#2",
      "house:easy#2",
    ]);
  });

  it("adds nothing to a full room, and never overfills", () => {
    const full = Array.from({ length: 20 }, (_, n) => ({ author: `u${n}` }));
    expect(houseFill(full, 20, 1)).toEqual([]);
    expect(houseFill([{ author: "a" }], 3, 1)).toHaveLength(2);
  });
});

describe("houseToRetire", () => {
  it("retires the smallest house snakes, then the youngest, then by id", () => {
    const house = [
      { lifeId: "big", mass: 90, startTick: 0 },
      { lifeId: "small-old", mass: 12, startTick: 10 },
      { lifeId: "small-young", mass: 12, startTick: 400 },
      { lifeId: "tiny-b", mass: 5, startTick: 0 },
      { lifeId: "tiny-a", mass: 5, startTick: 0 },
    ];
    expect(houseToRetire(house, 4)).toEqual(["tiny-a", "tiny-b", "small-young", "small-old"]);
    expect(houseToRetire(house, 0)).toEqual([]);
  });
});

describe("batchTicks", () => {
  // (15 000 − 1 000 − starts × 267) / (bots × 27 + 2), clamped to [1, 500].
  it("sizes a batch for the worst case, between 1 and 500 ticks", () => {
    expect([batchTicks(5, 0), batchTicks(6, 1), batchTicks(6, 6), batchTicks(1, 0)]).toEqual([
      102, 83, 75, 482,
    ]);
    // Twenty sandboxed bots: 25 ticks, with or without a life starting.
    expect([batchTicks(20, 0), batchTicks(20, 1)]).toEqual([25, 25]);
    // One ticket and 19 native house bots (0.25 ms a tick, 1 ms a start), all starting.
    expect(batchTicks(1, 1, undefined, 19, 19)).toBe(406);
    expect(batchTicks(20, 60)).toBe(1);
  });
});
