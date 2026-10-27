import { describe, expect, it } from "vitest";
import {
  pickShowcase,
  SHOWCASE_REST_MS,
  SHOWCASE_SLOTS,
  SHOWCASE_STALE_MS,
  SHOWCASE_TURN_MS,
  type ShowcaseCandidate,
  type ShowcaseTurn,
} from "./rule.ts";

const now = 100_000_000;

function room(objectId: string, realLives: number, mass = 100, at = now): ShowcaseCandidate {
  return { objectId, roomId: objectId, tick: 0, realLives, snakes: 10, mass, spectators: 0, at };
}

const turn = (objectId: string, since = now - 1000): ShowcaseTurn => ({ objectId, since });
const ids = (r: { turns: ShowcaseTurn[] }) => r.turns.map((t) => t.objectId);

describe("pickShowcase", () => {
  it("shows one room: the home page's", () => {
    expect(SHOWCASE_SLOTS).toBe(1);
  });

  it("picks the rooms with the most deployed bots, then the most mass", () => {
    const rooms = [room("a", 2), room("b", 5), room("c", 5, 900), room("d", 0, 5000)];
    expect(ids(pickShowcase(rooms, [], {}, now, 2))).toEqual(["c", "b"]);
    expect(pickShowcase(rooms, [], {}, now).turns).toEqual([{ objectId: "c", since: now }]);
  });

  it("keeps a showcase room during its turn, so spectators stay put", () => {
    const rooms = [room("a", 1), room("b", 5), room("c", 9)];
    expect(ids(pickShowcase(rooms, [turn("a")], {}, now, 2))).toEqual(["a", "c"]);
    expect(ids(pickShowcase(rooms, [turn("b"), turn("a")], {}, now, 2))).toEqual(["b", "a"]);
    expect(pickShowcase(rooms, [turn("a", now - 5)], {}, now).turns).toEqual([turn("a", now - 5)]);
  });

  it("replaces rooms that went stale, lost their last deployed bot or closed", () => {
    const rooms = [room("a", 3, 100, now - SHOWCASE_STALE_MS), room("b", 0), room("c", 1)];
    expect(ids(pickShowcase(rooms, [turn("a"), turn("b")], {}, now, 2))).toEqual(["c"]);
    expect(ids(pickShowcase(rooms, [turn("gone")], {}, now))).toEqual(["c"]);
    expect(ids(pickShowcase([], [turn("a")], {}, now))).toEqual([]);
  });

  it("ends a room's turn even while it's the best, and rests it", () => {
    const rooms = [room("best", 9), room("next", 1)];
    const ended = pickShowcase(rooms, [turn("best", now - SHOWCASE_TURN_MS)], {}, now);
    expect(ended.turns).toEqual([{ objectId: "next", since: now }]);
    expect(ended.resting).toEqual({ best: now + SHOWCASE_REST_MS });

    // Resting, it isn't picked again, even when the slot frees up.
    const later = now + SHOWCASE_REST_MS - 1;
    const gone = pickShowcase([room("best", 9, 100, later)], ended.turns, ended.resting, later);
    expect(gone.turns).toEqual([]);
    // After its rest it's a candidate like any other.
    const after = now + SHOWCASE_REST_MS;
    const back = pickShowcase([room("best", 9, 100, after)], [], ended.resting, after);
    expect(back).toEqual({ turns: [{ objectId: "best", since: after }], resting: {} });
  });

  it("leaves the slot empty rather than keep the only room in real time for good", () => {
    const only = [room("only", 4)];
    const r = pickShowcase(only, [turn("only", now - SHOWCASE_TURN_MS - 1)], {}, now);
    expect(r.turns).toEqual([]);
    expect(Object.keys(r.resting)).toEqual(["only"]);
  });
});
