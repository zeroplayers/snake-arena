/**
 * Scripted policies for engine tests, standing in for house bots until they exist. They read
 * the full world (no vision radius) and may use Math.atan2: test code, not engine code.
 */
import { createRng } from "../rng";
import type { Action, ActionMap, Snake, World } from "../types";

export type Policy = (snake: Snake, world: World) => Action;

/** Turn towards a heading: positive `turn` is clockwise (decreasing angle). */
export function steerTo(snake: Snake, heading: number, turnRate: number): number {
  let diff = heading - snake.angle;
  diff -= 2 * Math.PI * Math.round(diff / (2 * Math.PI));
  return Math.max(-1, Math.min(1, -diff / turnRate));
}

/** Spins on the spot forever. */
export const circle: Policy = () => ({ turn: 1 });

/** Heads for the nearest pellet it can reach without orbiting it, turning back from the wall. */
export const farm: Policy = (snake, world) => {
  const c = world.config;
  const { x, y } = snake.head;
  if (Math.hypot(x, y) > c.arenaRadius * 0.85) {
    return { turn: steerTo(snake, Math.atan2(-y, -x), c.turnRate) };
  }
  // A pellet at distance d, bearing φ off the heading, lies on a circle of radius d / (2 sin φ)
  // through the head; it is reachable if that is no tighter than the turning circle.
  const turnRadius = c.speed / c.turnRate;
  const reach = snake.size * c.eatRadiusFactor;
  let best = Number.POSITIVE_INFINITY;
  let heading = snake.angle;
  for (const f of world.food) {
    const d = Math.hypot(f.x - x, f.y - y);
    if (d >= best) continue;
    const bearing = Math.atan2(f.y - y, f.x - x);
    const phi = Math.abs(Math.sin(bearing - snake.angle));
    if (d + reach < 2 * turnRadius * phi) continue;
    best = d;
    heading = bearing;
  }
  return { turn: steerTo(snake, heading, c.turnRate) };
};

/** Random walk with wall avoidance and occasional boosts, seeded. */
export function wander(seed: number): Policy {
  const rng = createRng(seed);
  return (snake, world) => {
    const c = world.config;
    const { x, y } = snake.head;
    if (Math.hypot(x, y) > c.arenaRadius * 0.85) {
      return { turn: steerTo(snake, Math.atan2(-y, -x), c.turnRate) };
    }
    return { turn: rng.range(-1, 1), boost: rng.next() < 0.05 };
  };
}

/** Runs `policies` (by snake id) for the living snakes. */
export function actionsFor(world: World, policies: Readonly<Record<string, Policy>>): ActionMap {
  const actions: Record<string, Action> = {};
  for (const s of world.snakes) {
    const p = policies[s.id];
    if (p) actions[s.id] = p(s, world);
  }
  return actions;
}
