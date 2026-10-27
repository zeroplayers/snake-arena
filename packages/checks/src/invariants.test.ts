import type { BotState, SnakeView } from "@zerosnake/sdk";
import { describe, expect, it } from "vitest";
import { ARENA_INVARIANTS } from "./testing/invariants.ts";

// The detector used by checks.test.ts, run on hand-made views: it must accept what RoomDO
// produces and catch each tell a check room used to show.
const checkArena = new Function(`${ARENA_INVARIANTS}; return checkArena;`)() as (
  state: BotState,
) => void;

const ME = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const USER = "6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b";
const snake = (id: string, author: string): SnakeView => ({
  id,
  author,
  length: 10,
  radius: 1,
  head: null,
  angle: null,
  boosting: false,
  segments: [],
});
const view = (snakes: SnakeView[], tick = 123_456, id = ME): BotState => ({
  tick,
  lifeTick: 5,
  self: {
    id,
    head: { x: 0, y: 0 },
    angle: 0,
    length: 10,
    speed: 1.5,
    radius: 1,
    turnRate: 0.25,
    boosting: false,
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
        snake(USER, "0f8e3a1c-5a2b-4c3d-8e9f-1a2b3c4d5e6f"),
      ]),
    );
  });

  it.each([
    ["the old check names", view([snake("house-easy-100000-0", "house:easy")]), /fill order/],
    [
      "several house bots of one tick all at index 0",
      view([
        snake("house-medium-100000-0", "house:medium"),
        snake("house-hard-100000-0", "house:hard"),
      ]),
      /fill order/,
    ],
    ["the old candidate id", view([], 123_456, "you"), /own id/],
    ["a tick near 0", view([], 500), /tick 500/],
    ["the old house author", view([snake("house-medium-1-0", "house")]), /house author/],
    ["a named opponent", view([snake("easy", "house")]), /snake easy/],
    ["one author twice", view([snake(USER, ME), snake(ME, ME)]), /author twice/],
  ])("catches %s", (_, state, tell) => {
    expect(() => checkArena(state)).toThrow(tell);
  });
});
