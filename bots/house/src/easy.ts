import { CENTER, defineBot, steerToward } from "@zerosnake/sdk";
import { nearestReachableFood } from "./common.ts";

/** Starts heading for the centre once the wall is this close. Late on purpose: easy is weak. */
const WALL_MARGIN = 8;

/**
 * `easy`: heads for the nearest food and turns back from the wall at the last moment. Ignores
 * other snakes completely. It is the qualification bar: a deployed bot must beat it.
 */
export const easy = defineBot({
  tick(state) {
    const { self } = state;
    if (state.wallDistance < WALL_MARGIN) return { turn: steerToward(self, CENTER) };
    const food = nearestReachableFood(state);
    return { turn: food ? steerToward(self, food) : 0 };
  },
});
