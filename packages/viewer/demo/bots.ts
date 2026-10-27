/**
 * Stand-in bots for the demo until house bots (`bots/house`) and the sandbox land. They read
 * the engine world directly but only look within `vision`, and log what they decide so the
 * viewer's log panel has something to show.
 */
import { type Action, createRng, type Rng, type Snake, type World } from "@zerosnake/engine";
import type { LogFn } from "@zerosnake/sdk";
import type { LiveBot } from "../src/index.ts";

const WALL_MARGIN = 12;
const DANGER_RANGE = 7;

function angleDiff(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  else if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** `turn` that heads towards `heading`; positive turn is clockwise. */
function steer(snake: Snake, heading: number, world: World): number {
  return Math.max(-1, Math.min(1, -angleDiff(heading, snake.angle) / world.config.turnRate));
}

/** Steers home when close to the wall; `undefined` when the wall is far. */
function avoidWall(snake: Snake, world: World, log: LogFn): Action | undefined {
  const { x, y } = snake.head;
  const left = world.config.arenaHalfSize - Math.max(Math.abs(x), Math.abs(y));
  if (left > WALL_MARGIN + snake.size * 2) return undefined;
  log(`wall ${left.toFixed(1)} away, turning in`);
  return { turn: steer(snake, Math.atan2(-y, -x), world) };
}

/** Swerves from the closest foreign body point in front of the head. */
function avoidBodies(snake: Snake, world: World, log: LogFn): Action | undefined {
  const { x, y } = snake.head;
  let best = DANGER_RANGE + snake.size * 2;
  let threat: { id: string; bearing: number } | undefined;
  for (const other of world.snakes) {
    if (other === snake) continue;
    for (const p of other.segments) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d >= best) continue;
      const bearing = Math.atan2(p.y - y, p.x - x);
      if (Math.abs(angleDiff(bearing, snake.angle)) > Math.PI / 2.5) continue;
      best = d;
      threat = { id: other.id, bearing };
    }
  }
  if (!threat) return undefined;
  // Threat on the left (counter-clockwise of the heading): turn right, which is positive.
  const away = angleDiff(threat.bearing, snake.angle) > 0 ? 1 : -1;
  log(`body of ${threat.id} ${best.toFixed(1)} ahead, swerving ${away > 0 ? "right" : "left"}`);
  return { turn: away };
}

/** Nearest pellet in vision that the turning circle can reach. */
function nearestFood(snake: Snake, world: World, vision: number) {
  const c = world.config;
  const { x, y } = snake.head;
  const turnRadius = c.speed / c.turnRate;
  const reach = snake.size * c.eatRadiusFactor;
  let best: { x: number; y: number; d: number; value: number } | undefined;
  for (const f of world.food) {
    const d = Math.hypot(f.x - x, f.y - y);
    if (d > vision || (best && d >= best.d)) continue;
    const phi = Math.abs(Math.sin(Math.atan2(f.y - y, f.x - x) - snake.angle));
    if (d + reach < 2 * turnRadius * phi) continue;
    best = { x: f.x, y: f.y, d, value: f.value };
  }
  return best;
}

function forage(snake: Snake, world: World, vision: number, log: LogFn): Action {
  const food = nearestFood(snake, world, vision);
  if (!food) {
    log("no food in sight, cruising");
    return { turn: 0.15 };
  }
  log(`food ${food.d.toFixed(1)} away (+${food.value.toFixed(1)})`);
  const heading = Math.atan2(food.y - snake.head.y, food.x - snake.head.x);
  return { turn: steer(snake, heading, world) };
}

function safety(snake: Snake, world: World, log: LogFn): Action | undefined {
  return avoidWall(snake, world, log) ?? avoidBodies(snake, world, log);
}

/** Eats the nearest reachable pellet; dodges walls and bodies. */
export function forager(name: string, vision: number): LiveBot {
  return {
    name,
    act: (snake, world, log) => safety(snake, world, log) ?? forage(snake, world, vision, log),
  };
}

/** Forages, but runs from any other head within `fear` units. */
export function coward(name: string, vision: number, fear = 18): LiveBot {
  return {
    name,
    act(snake, world, log) {
      const safe = safety(snake, world, log);
      if (safe) return safe;
      const { x, y } = snake.head;
      for (const other of world.snakes) {
        if (other === snake) continue;
        const d = Math.hypot(other.head.x - x, other.head.y - y);
        if (d > fear) continue;
        log(`${other.id} is ${d.toFixed(1)} away, fleeing`);
        const away = Math.atan2(y - other.head.y, x - other.head.x);
        return { turn: steer(snake, away, world), boost: d < fear / 2 };
      }
      return forage(snake, world, vision, log);
    },
  };
}

/** Cuts in front of the nearest visible head and boosts in for the kill. */
export function hunter(name: string, vision: number): LiveBot {
  return {
    name,
    act(snake, world, log) {
      const safe = safety(snake, world, log);
      if (safe) return safe;
      const { x, y } = snake.head;
      let prey: Snake | undefined;
      let best = vision;
      for (const other of world.snakes) {
        if (other === snake) continue;
        const d = Math.hypot(other.head.x - x, other.head.y - y);
        if (d < best) {
          best = d;
          prey = other;
        }
      }
      if (!prey || snake.mass < 12) return forage(snake, world, vision, log);
      const lead = Math.min(12, best);
      const tx = prey.head.x + Math.cos(prey.angle) * lead;
      const ty = prey.head.y + Math.sin(prey.angle) * lead;
      const boost = best < 15 && snake.mass > 15;
      log(`hunting ${prey.id} at ${best.toFixed(1)}${boost ? ", boosting" : ""}`);
      return { turn: steer(snake, Math.atan2(ty - y, tx - x), world), boost };
    },
  };
}

/** Random walk with the occasional sprint. */
export function wanderer(name: string): LiveBot {
  const rngs = new Map<string, Rng>();
  return {
    name,
    act(snake, world, log) {
      const safe = avoidWall(snake, world, log);
      if (safe) return safe;
      let rng = rngs.get(snake.id);
      if (!rng) {
        rng = createRng(snake.seed);
        rngs.set(snake.id, rng);
      }
      const turn = rng.range(-1, 1);
      const boost = rng.next() < 0.04;
      log(`turn ${turn.toFixed(2)}${boost ? ", sprint" : ""}`);
      return { turn, boost };
    },
  };
}

export function demoBots(vision: number): LiveBot[] {
  return [
    forager("forager", vision),
    forager("grazer", vision),
    hunter("hunter", vision),
    hunter("stalker", vision),
    coward("coward", vision),
    coward("skittish", vision),
    wanderer("wanderer"),
    wanderer("drifter"),
  ];
}
