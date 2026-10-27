import { describe, expect, it } from "vitest";
import { pickShowcase, SHOWCASE_STALE_MS, type ShowcaseCandidate } from "./rule.ts";

const now = 1_000_000;

function room(objectId: string, realLives: number, mass = 100, at = now): ShowcaseCandidate {
  return { objectId, roomId: objectId, tick: 0, realLives, snakes: 10, mass, spectators: 0, at };
}

describe("pickShowcase", () => {
  it("picks the rooms with the most deployed bots, then the most mass", () => {
    const rooms = [room("a", 2), room("b", 5), room("c", 5, 900), room("d", 0, 5000)];
    expect(pickShowcase(rooms, [], now)).toEqual(["c", "b"]);
    expect(pickShowcase(rooms, [], now, 1)).toEqual(["c"]);
  });

  it("keeps a showcase room while it's alive, so spectators stay put", () => {
    const rooms = [room("a", 1), room("b", 5), room("c", 9)];
    expect(pickShowcase(rooms, ["a"], now)).toEqual(["a", "c"]);
    expect(pickShowcase(rooms, ["b", "a"], now)).toEqual(["b", "a"]);
  });

  it("replaces rooms that went stale, lost their last deployed bot or closed", () => {
    const rooms = [room("a", 3, 100, now - SHOWCASE_STALE_MS), room("b", 0), room("c", 1)];
    expect(pickShowcase(rooms, ["a", "b"], now)).toEqual(["c"]);
    expect(pickShowcase(rooms, ["gone"], now)).toEqual(["c"]);
    expect(pickShowcase([], ["a"], now)).toEqual([]);
  });
});
