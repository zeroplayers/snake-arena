import { defineBot, steerToward, turnToward } from "@zerosnake/sdk";
import { nearestReachableFood, nearWall, turnRadius } from "./common.ts";

/** Turns straight away from the wall once it is this close. Late on purpose: easy is weak. */
const WALL_MARGIN = 8;
/**
 * In the corners the wall counts as rounded off to this many turning radii, so easy turns back
 * there in time, as it did from the round arena's wall: it is the qualification bar, and dying in
 * corners would lower it.
 */
const CORNER_TURN_RADII = 4;

/**
 * `easy`: heads for the nearest food and turns back from the wall at the last moment. Ignores
 * other snakes completely. It is the qualification bar: a deployed bot must beat it.
 */
export const easy = defineBot({
  tick(state) {
    const { self } = state;
    const wall = nearWall(state, turnRadius(self) * CORNER_TURN_RADII);
    if (wall.distance < WALL_MARGIN) return { turn: turnToward(self, wall.away) };
    const food = nearestReachableFood(state);
    return { turn: food ? steerToward(self, food) : 0 };
  },
});
