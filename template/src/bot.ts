/**
 * A simple starter bot: eat the nearest food you can reach, but never steer into a body or the
 * wall. It is meant to be read and replaced, not to win. See CLAUDE.md for the rules and API.
 *
 * Each tick it:
 *  1. decides where it would like to go;
 *  2. checks that steering by driving a few ticks ahead in its head: would it touch a visible
 *     body or the arena edge? If so, it tries a handful of other steering values ("feelers")
 *     from hard left to hard right;
 *  3. goes the way it wants (toward food, back from the wall, or straight) if that is safe,
 *     otherwise takes the feeler that stays clear longest.
 */
import {
  angleDiff,
  angleTo,
  type BotState,
  CENTER,
  defineBot,
  distance,
  type Food,
  normalizeAngle,
  type SelfState,
  steerToward,
  type Vec,
} from "@zerosnake/sdk";

/** Steering values to try, from full left (-1) to full right (1). */
const FEELERS = [-1, -0.6, -0.3, 0, 0.3, 0.6, 1];
/** How many ticks ahead each feeler looks. */
const LOOKAHEAD_TICKS = 10;
/** Extra space (world units) to keep from other bodies, on top of both radii. */
const BODY_MARGIN = 1;
/** Start turning back toward the centre when the wall is this many turning radii away. */
const WALL_TURN_RADII = 3;

type Mode = "eat" | "wander" | "avoid" | "wall";

export default defineBot({
  init() {
    // Memory: whatever `init` returns is passed to every `tick` of this life.
    return { mode: "wander" as Mode, ticksInMode: 0 };
  },

  tick(state, mem, log) {
    const { self } = state;

    // 1. Where would we like to go?
    let wanted: number;
    let mode: Mode;
    const food = nearestReachableFood(state);
    if (state.wallDistance < turnRadius(self) * WALL_TURN_RADII) {
      wanted = steerToward(self, CENTER);
      mode = "wall";
    } else if (food) {
      wanted = steerToward(self, food);
      mode = "eat";
    } else {
      wanted = 0;
      mode = "wander";
    }

    // 2. Is that safe for the next few ticks? If not, take the feeler that stays clear longest
    //    (ties: the one closest to what we wanted).
    const obstacles = nearbyBodies(state, self.speed * LOOKAHEAD_TICKS + self.radius * 2);
    let turn = wanted;
    if (safeTicks(self, wanted, obstacles, state.wallDistance) < LOOKAHEAD_TICKS) {
      mode = "avoid";
      let bestCost = Number.POSITIVE_INFINITY;
      for (const feeler of FEELERS) {
        const lost = LOOKAHEAD_TICKS - safeTicks(self, feeler, obstacles, state.wallDistance);
        const cost = lost * 10 + Math.abs(feeler - wanted);
        if (cost < bestCost) {
          bestCost = cost;
          turn = feeler;
        }
      }
    }

    // 3. Remember what we were doing; log only when it changes, to keep traces readable.
    if (mode !== mem.mode) {
      log(
        `${mem.mode} -> ${mode} after ${mem.ticksInMode} ticks, length ${self.length.toFixed(1)}`,
      );
      mem.mode = mode;
      mem.ticksInMode = 0;
    }
    mem.ticksInMode++;

    return { turn, boost: false };
  },
});

/** Radius of the tightest circle we can drive: speed / turnRate (about 6 units by default). */
function turnRadius(self: Pick<SelfState, "speed" | "turnRate">): number {
  return self.turnRate > 0 ? self.speed / self.turnRate : Number.POSITIVE_INFINITY;
}

/** A circle the head must stay out of: `r` already includes our own radius and the margin. */
interface Obstacle extends Vec {
  r: number;
}

/** Every visible body point of other snakes within `range` of our head, as circles to avoid. */
function nearbyBodies(state: BotState, range: number): Obstacle[] {
  const { head, radius } = state.self;
  const out: Obstacle[] = [];
  for (const snake of state.snakes) {
    const r = radius + snake.radius + BODY_MARGIN;
    for (const p of snake.segments) {
      if (distance(head, p) <= range + r) out.push({ x: p.x, y: p.y, r });
    }
  }
  return out;
}

/**
 * Drives `turn` forward tick by tick, the way the engine does (`angle -= turn * turnRate`, then
 * move `speed`), and returns how many ticks pass before the head would touch an obstacle or the
 * wall. Returns {@link LOOKAHEAD_TICKS} if it stays clear the whole time.
 */
function safeTicks(self: SelfState, turn: number, obstacles: Obstacle[], wallDistance: number) {
  const arenaRadius = Math.hypot(self.head.x, self.head.y) + wallDistance;
  let { x, y } = self.head;
  let angle = self.angle;
  for (let t = 0; t < LOOKAHEAD_TICKS; t++) {
    angle = normalizeAngle(angle - turn * self.turnRate);
    x += Math.cos(angle) * self.speed;
    y += Math.sin(angle) * self.speed;
    if (Math.hypot(x, y) > arenaRadius - self.radius) return t;
    for (const o of obstacles) {
      if (Math.hypot(x - o.x, y - o.y) < o.r) return t;
    }
  }
  return LOOKAHEAD_TICKS;
}

/**
 * The nearest food we can drive over without circling it. Food beside the head is inside our
 * turning circle: chasing it makes the snake orbit forever, so it is skipped.
 */
function nearestReachableFood(state: BotState): Food | undefined {
  const { self } = state;
  const r = turnRadius(self);
  let best: Food | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  for (const f of state.food) {
    const d = distance(self.head, f);
    const bearing = angleDiff(self.angle, angleTo(self.head, f));
    // A point at distance d and bearing φ lies on a circle of radius d / (2 |sin φ|) through the
    // head; it is reachable when that circle is no tighter than our turning circle.
    const reachable = d + self.radius * 4 >= 2 * r * Math.abs(Math.sin(bearing));
    if (reachable && d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return best;
}
