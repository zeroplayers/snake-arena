import {
  angleDiff,
  angleTo,
  type BotState,
  defineBot,
  distance,
  project,
  type SnakeView,
  type Vec,
} from "@zerosnake/sdk";
import { arenaHalfSize, bestFood, collectObstacles, steer } from "./common.ts";

/** Only snakes this much smaller are hunted, so a botched cut-off still wins the head-on. */
const PREY_RATIO = 0.8;
/** Prey heads farther than this are ignored. */
const HUNT_RANGE = 20;
/** Aim this far ahead of the prey's head: our body ends up across its road. */
const LEAD = 10;
/** Our body must be at least this many segments long to work as a wall. */
const MIN_HUNT_SEGMENTS = 12;
/** Boosting burns length; never boost below this. */
const MIN_BOOST_LENGTH = 40;
/** Boost for the cut only when the aim point is this close. */
const BOOST_RANGE = 15;
/** Skip cuts whose aim point is this close to the wall. */
const WALL_MARGIN = 10;

const OBSTACLES = { range: 20, margin: 1, headLead: 3 };
const STEER = { rays: 16, lookahead: 20, safe: 10, dangerWeight: 10, reversalCost: 0.5 };

type Visible = SnakeView & { head: Vec; angle: number };

/** Where to aim to cut off the closest smaller snake whose head we see, if any. */
function cutOff(state: BotState): Vec | undefined {
  const { self } = state;
  if (self.segments.length < MIN_HUNT_SEGMENTS) return undefined;
  const wall = arenaHalfSize(state) - WALL_MARGIN;
  let best: Vec | undefined;
  let bestD = HUNT_RANGE;
  for (const snake of state.snakes) {
    if (snake.head === null || snake.angle === null) continue;
    if (snake.length >= self.length * PREY_RATIO) continue;
    const prey = snake as Visible;
    const d = distance(self.head, prey.head);
    if (d >= bestD) continue;
    const aim = project(prey.head, prey.angle, LEAD);
    if (Math.max(Math.abs(aim.x), Math.abs(aim.y)) > wall) continue;
    // Only cuts we can make without turning around.
    if (Math.abs(angleDiff(self.angle, angleTo(self.head, aim))) > Math.PI / 2) continue;
    bestD = d;
    best = aim;
  }
  return best;
}

/**
 * `hard`: steers like `medium`, but hunts. When a much smaller snake's head is close, it drives
 * to a point just ahead of that head, so its own long body ends up across the prey's road, and
 * boosts for the cut when lined up, long enough and the road is clear. Otherwise it farms the
 * best-value food.
 */
export const hard = defineBot({
  init: () => ({ turn: 0 }),
  tick(state, mem) {
    const { self } = state;
    const obstacles = collectObstacles(state, OBSTACLES);
    const aim = cutOff(state);
    const target = aim ?? bestFood(state);
    const desired = target ? angleTo(self.head, target) : self.angle;
    const s = steer(state, obstacles, desired, STEER, mem.turn);
    mem.turn = s.turn;
    const boost =
      aim !== undefined &&
      self.length >= MIN_BOOST_LENGTH &&
      distance(self.head, aim) < BOOST_RANGE &&
      Math.abs(angleDiff(self.angle, desired)) < 0.3 &&
      Math.abs(angleDiff(s.angle, desired)) < 1e-9 &&
      s.ahead >= STEER.lookahead;
    return { turn: s.turn, boost };
  },
});
