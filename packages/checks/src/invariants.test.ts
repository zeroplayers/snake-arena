import type { BotState, SnakeView } from "@zerosnake/sdk";
import { describe, expect, it } from "vitest";
import { ARENA_INVARIANTS } from "./testing/invariants.ts";

// The detector used by checks.test.ts, run on hand-made views: it must accept what RoomDO
// produces and catch each tell a check room used to show.
const checkArena = new Function(`${ARENA_INVARIANTS}; return checkArena;`)() as (
  state: BotState,
) => void;

const ME = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const LIFE = "6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b";
// Better Auth user ids; the first comes from a real sign-up.
const USER = "EwHtzo4BxLbOftvbTBy6BjWVEorxGVKa";
const OTHER_USER = "q3Zr8LkP0aWm5TnYx2BcVd7GhJ4sEf9u";
const snake = (id: string, author: string): SnakeView => ({
  id,
  author,
  length: 10,
  radius: 1,
  head: null,
  angle: null,
  boosting: false,
  spawnGrace: 0,
  segments: [],
});
const view = (snakes: SnakeView[], tick = 123_456, id = ME, lifeTick = 5): BotState => ({
  tick,
  lifeTick,
  self: {
    id,
    head: { x: 0, y: 0 },
    angle: 0,
    length: 10,
    speed: 1.5,
    radius: 1,
    turnRate: 0.4,
    boosting: false,
    spawnGrace: 0,
    segments: [],
  },
  snakes,
  food: [],
  wallDistance: 50,
});

describe("the arena-invariants detector", () => {
  it("accepts a room filled the way RoomDO fills it", () => {
    checkArena(
      view([
        snake("house-medium-100000-0", "house:medium"),
        snake("house-easy-100000-1", "house:easy"),
        snake("house-medium-120000-0", "house:medium#2"),
        snake(LIFE, USER),
      ]),
    );
  });

  it("accepts replacements of the kind the room had fewest of, and many copies of a kind", () => {
    checkArena(
      view([
        snake("house-easy-100000-0", "house:easy"),
        snake("house-chaos-100000-1", "house:chaos#2"),
        snake("house-medium-90000-0", "house:medium#12"),
        snake(LIFE, USER),
      ]),
    );
  });

  it("accepts a room that has just opened at tick 0", () => {
    checkArena(
      view(
        [snake("house-medium-0-0", "house:medium"), snake("house-easy-0-1", "house:easy")],
        0,
        ME,
        0,
      ),
    );
  });

  it.each([
    ["a house kind the arena doesn't have", view([snake("house-noob-1-0", "house:noob")]), /kind/],
    ["a house copy numbered 1", view([snake("house-easy-1-0", "house:easy#1")]), /house author/],
    ["the old candidate id", view([], 123_456, "you"), /own id/],
    ["a negative tick", view([], -1, ME, 0), /tick -1/],
    ["a life older than its room", view([], 3, ME, 5), /older than the room/],
    ["a UUID user id", view([snake(LIFE, "0f8e3a1c-5a2b-4c3d-8e9f-1a2b3c4d5e6f")]), /snake/],
    ["the old house author", view([snake("house-medium-1-0", "house")]), /house author/],
    ["a named opponent", view([snake("easy", "house")]), /snake easy/],
    ["one author twice", view([snake(LIFE, OTHER_USER), snake(ME, OTHER_USER)]), /author twice/],
  ])("catches %s", (_, state, tell) => {
    expect(() => checkArena(state)).toThrow(tell);
  });
});
