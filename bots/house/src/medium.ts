import { angleTo, defineBot } from "@zerosnake/sdk";
import { collectObstacles, nearestReachableFood, steer } from "./common.ts";

const OBSTACLES = { range: 20, margin: 1, headLead: 3 };
const STEER = { rays: 16, lookahead: 20, safe: 10, dangerWeight: 10 };

/**
 * `medium`: heads for the nearest food like `easy`, but estimates the danger on every road it
 * could take (visible bodies, the road just ahead of other heads, the wall) and picks the open
 * road closest to the food. Never boosts.
 */
export const medium = defineBot({
  tick(state) {
    const { self } = state;
    const food = nearestReachableFood(state);
    const desired = food ? angleTo(self.head, food) : self.angle;
    const s = steer(state, collectObstacles(state, OBSTACLES), desired, STEER);
    return { turn: s.turn };
  },
});
