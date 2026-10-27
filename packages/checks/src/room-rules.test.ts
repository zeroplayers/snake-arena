import { describe, expect, it } from "vitest";
import { batchTicks, houseFill } from "./room-rules.ts";

// Pins the port of RoomDO's rules (apps/arena/src/room/house.ts and limits.ts, PR #56). If the
// arena changes them, these must change with it, or a check room becomes recognisable.
describe("houseFill", () => {
  it("tops a room up to 5 authors in fill order, numbering the spawns of one tick", () => {
    expect(houseFill([{ author: "u1" }], 20, 5, 1234)).toEqual([
      { lifeId: "house-medium-1234-0", author: "house:medium", house: "medium" },
      { lifeId: "house-easy-1234-1", author: "house:easy", house: "easy" },
      { lifeId: "house-hard-1234-2", author: "house:hard", house: "hard" },
      { lifeId: "house-chaos-1234-3", author: "house:chaos", house: "chaos" },
    ]);
  });

  it("names a second copy of a kind by its author, not its id", () => {
    expect(houseFill([{ author: "house:medium" }, { author: "u1" }], 20, 5, 7)).toEqual([
      { lifeId: "house-medium-7-0", author: "house:medium#2", house: "medium" },
      { lifeId: "house-easy-7-1", author: "house:easy", house: "easy" },
      { lifeId: "house-hard-7-2", author: "house:hard", house: "hard" },
    ]);
    expect(houseFill([], 20, 5, 0).map((h) => h.author)).toEqual([
      "house:medium",
      "house:easy",
      "house:hard",
      "house:chaos",
      "house:medium#2",
    ]);
  });

  it("adds nothing once there are enough authors, and never overfills", () => {
    const five = ["a", "b", "c", "d", "e"].map((author) => ({ author }));
    expect(houseFill(five, 20, 5, 1)).toEqual([]);
    expect(houseFill([{ author: "a" }], 3, 5, 1)).toHaveLength(2);
  });
});

describe("batchTicks", () => {
  // (15 000 − 1 000 − starts × 267) / (bots × 27 + 2), clamped to [1, 500].
  it("sizes a batch for the worst case, between 1 and 500 ticks", () => {
    expect([batchTicks(5, 0), batchTicks(6, 1), batchTicks(6, 6), batchTicks(1, 0)]).toEqual([
      102, 83, 75, 482,
    ]);
    expect(batchTicks(20, 60)).toBe(1);
  });
});
