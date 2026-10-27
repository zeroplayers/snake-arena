/**
 * A simple starter bot: go for the best food in reach, but never steer into a body, the road
 * another snake is about to take, or the wall. It is meant to be read and replaced. See CLAUDE.md
 * for the rules and API.
 *
 * Each tick it:
 *  1. picks a target: the centre when the wall is close, else the food worth the shortest detour;
 *  2. drives there in its head for the next few ticks: would it touch a visible body, the road
 *     ahead of another head, or the arena edge?
 *  3. goes for the target if that is safe, otherwise tries a handful of headings ("feelers") all
 *     around and takes the one that stays clear longest.
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
  turnToward,
  type Vec,
} from "@zerosnake/sdk";

/** Headings to try when the way to the target is blocked: ours, then every 45° to both sides. */
const FEELERS = [0, 1, -1, 2, -2, 3, -3, 4].map((k) => (k * Math.PI) / 4);
/** How many ticks ahead every road is checked. */
const LOOKAHEAD_TICKS = 24;
/** Extra space (world units) to keep from other bodies, on top of both radii. */
const BODY_MARGIN = 1;
/** Extra space to keep from the road ahead of another head. */
const HEAD_MARGIN = 1;
/** Other heads can turn: the space kept from their road grows by this share of a tick's move per tick. */
const HEAD_SPREAD = 0.3;
/** Head back toward the centre when the wall is closer than this many turning radii. */
const WALL_TURN_RADII = 1;

type Mode = "eat" | "wander" | "avoid" | "wall";

export default defineBot({
  init() {
    // Memory: whatever `init` returns is passed to every `tick` of this life.
    return { mode: "wander" as Mode, ticksInMode: 0 };
  },

  tick(state, mem, log) {
    const { self } = state;

    // 1. Where would we like to go?
    let target: Vec | undefined;
    let mode: Mode;
    const food = bestFood(state);
    if (state.wallDistance < turnRadius(self) * WALL_TURN_RADII) {
      target = CENTER;
      mode = "wall";
    } else if (food) {
      target = food;
      mode = "eat";
    } else {
      mode = "wander";
    }

    // 2. Is the way there safe for the next few ticks? If not, take the feeler that stays clear
    //    longest (ties: the one closest to where we wanted to go).
    const danger = dangerAround(state);
    let turn = target ? steerToward(self, target) : 0;
    if (safeTicks(self, target ?? self.angle, danger) < LOOKAHEAD_TICKS) {
      mode = "avoid";
      const wanted = target ? angleTo(self.head, target) : self.angle;
      const miss = (heading: number) => Math.abs(angleDiff(heading, wanted));
      // Closest to where we wanted to go first. A feeler costs at least its miss, so once the
      // cost to beat is below the next feeler's miss, the rest can't win: no need to drive them.
      const headings = FEELERS.map((offset) => self.angle + offset).sort(
        (a, b) => miss(a) - miss(b),
      );
      let bestCost = Number.POSITIVE_INFINITY;
      for (const heading of headings) {
        if (miss(heading) >= bestCost) break;
        const lost = LOOKAHEAD_TICKS - safeTicks(self, heading, danger);
        const cost = lost * 10 + miss(heading);
        if (cost < bestCost) {
          bestCost = cost;
          turn = turnToward(self, heading);
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

/**
 * A body point the head must stay out of: `r` already includes our own radius and the margin,
 * `r2` is `r * r` (comparing squared distances saves a square root per check), `reach` how far
 * our head must drive before it can touch the point.
 */
interface Body extends Vec {
  r: number;
  r2: number;
  reach: number;
}

/**
 * Another snake's head, and how far it moves per tick (`vx`, `vy`, `v2` = vx² + vy²) if it
 * drives straight on.
 */
interface Head extends Vec {
  r: number;
  vx: number;
  vy: number;
  v2: number;
}

/** What the head must stay clear of. */
interface Danger {
  /** Nearest first. */
  bodies: Body[];
  heads: Head[];
  arenaRadius: number;
}

/** Every visible body point near our head, every visible head, and the size of the arena. */
function dangerAround(state: BotState): Danger {
  const { self } = state;
  const range = self.speed * LOOKAHEAD_TICKS;
  const bodies: Body[] = [];
  const heads: Head[] = [];
  for (const snake of state.snakes) {
    const r = self.radius + snake.radius + BODY_MARGIN;
    let kept: Vec | undefined;
    for (const p of snake.segments) {
      // Body points are about 1 unit apart. Keeping one per `r` is enough (the circles still
      // overlap) and makes every check below several times cheaper.
      if (kept && distance(kept, p) < r) continue;
      kept = p;
      const reach = distance(self.head, p) - r;
      if (reach <= range) bodies.push({ x: p.x, y: p.y, r, r2: r * r, reach });
    }
    if (snake.head && snake.angle !== null) {
      // Other snakes move as fast as we do (twice that when boosting).
      const v = snake.boosting ? self.speed * 2 : self.speed;
      heads.push({
        x: snake.head.x,
        y: snake.head.y,
        r: self.radius + snake.radius + HEAD_MARGIN,
        vx: Math.cos(snake.angle) * v,
        vy: Math.sin(snake.angle) * v,
        v2: v * v,
      });
    }
  }
  bodies.sort((a, b) => a.reach - b.reach);
  const arenaRadius = Math.hypot(self.head.x, self.head.y) + state.wallDistance;
  return { bodies, heads, arenaRadius };
}

/**
 * Drives forward tick by tick the way the engine does (`angle -= turn * turnRate`, then move
 * `speed`), turning toward `aim` (a heading, or a point to drive over and then go straight on),
 * and returns how many ticks pass before the head would touch a body, the road another head has
 * taken by then, or the wall. Returns {@link LOOKAHEAD_TICKS} if it stays clear the whole time.
 */
function safeTicks(self: SelfState, aim: number | Vec, danger: Danger): number {
  const me = { head: { ...self.head }, angle: self.angle, turnRate: self.turnRate };
  const wall2 = (danger.arenaRadius - self.radius) ** 2;
  for (let t = 1; t <= LOOKAHEAD_TICKS; t++) {
    // Food within reach is eaten: from there on, straight on.
    if (typeof aim !== "number" && distance(me.head, aim) < self.radius * 6) aim = me.angle;
    const turn = typeof aim === "number" ? turnToward(me, aim) : steerToward(me, aim);
    me.angle = normalizeAngle(me.angle - turn * self.turnRate);
    me.head.x += Math.cos(me.angle) * self.speed;
    me.head.y += Math.sin(me.angle) * self.speed;
    const { x, y } = me.head;
    if (x * x + y * y > wall2) return t - 1;
    // Bodies are nearest first: stop at the first one we can't have reached yet.
    for (const b of danger.bodies) {
      if (b.reach > t * self.speed) break;
      const dx = x - b.x;
      const dy = y - b.y;
      if (dx * dx + dy * dy < b.r2) return t - 1;
    }
    for (const h of danger.heads) {
      // In t ticks another head lays its body along the road ahead of it: find the point of that
      // road nearest to us (k ticks along it) and keep clear of it.
      const along = ((x - h.x) * h.vx + (y - h.y) * h.vy) / h.v2;
      const k = along > 0 ? Math.min(along, t) : 0;
      const r = h.r + HEAD_SPREAD * self.speed * k;
      const dx = x - (h.x + h.vx * k);
      const dy = y - (h.y + h.vy * k);
      if (dx * dx + dy * dy < r * r) return t - 1;
    }
  }
  return LOOKAHEAD_TICKS;
}

/**
 * The food worth the shortest detour: distance plus the turn needed to face it, per unit of
 * value (remains of dead snakes are worth up to 10). Food beside the head is inside our turning
 * circle: chasing it makes the snake orbit forever, so it is skipped.
 */
function bestFood(state: BotState): Food | undefined {
  const { self } = state;
  const r = turnRadius(self);
  let best: Food | undefined;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const f of state.food) {
    const d = distance(self.head, f);
    const bearing = angleDiff(self.angle, angleTo(self.head, f));
    // A point at distance d and bearing φ lies on a circle of radius d / (2 |sin φ|) through the
    // head; it is reachable when that circle is no tighter than our turning circle.
    const reachable = d + self.radius * 4 >= 2 * r * Math.abs(Math.sin(bearing));
    const cost = (d + Math.abs(bearing) * r + 1) / f.value;
    if (reachable && cost < bestCost) {
      bestCost = cost;
      best = f;
    }
  }
  return best;
}
