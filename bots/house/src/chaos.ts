import { angleDiff, defineBot } from "@zerosnake/sdk";
import { collectObstacles, createRandom, steer } from "./common.ts";

const OBSTACLES = { range: 20, margin: 1, headLead: 3 };
const STEER = { rays: 16, lookahead: 20, safe: 12, dangerWeight: 10 };
/** Boosting burns length; never boost below this. */
const MIN_BOOST_LENGTH = 15;

/**
 * `chaos`: wanders at random, holding a random turn for a random while and boosting in random
 * bursts, but never drives into a body or the wall it can see: a blocked heading is replaced by
 * the nearest open one. Randomness comes from `info.seed`, so a life replays identically.
 */
export const chaos = defineBot({
  init(info) {
    return { random: createRandom(info.seed), turn: 0, hold: 0, boost: 0 };
  },
  tick(state, mem) {
    const { self } = state;
    if (mem.hold <= 0) {
      mem.turn = mem.random() * 2 - 1;
      mem.hold = 5 + Math.floor(mem.random() * 20);
      if (mem.random() < 0.15) mem.boost = 3 + Math.floor(mem.random() * 8);
    }
    mem.hold--;
    if (mem.boost > 0) mem.boost--;

    // Where the random turn would point us a few ticks from now.
    const desired = self.angle - mem.turn * self.turnRate * 4;
    const s = steer(state, collectObstacles(state, OBSTACLES), desired, STEER);
    const free = s.clearance >= STEER.safe;
    const onCourse = Math.abs(angleDiff(s.angle, desired)) < 1e-9;
    return {
      turn: free && onCourse ? mem.turn : s.turn,
      boost: mem.boost > 0 && free && s.ahead >= STEER.lookahead && self.length >= MIN_BOOST_LENGTH,
    };
  },
});
