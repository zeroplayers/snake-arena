import { segmentCountForMass, sizeForMass } from "../growth";
import { cos, sin } from "../math";
import type { Snake, World } from "../types";
import { layoutSegments, spawnSnake } from "../world";

export interface PlaceOptions {
  id: string;
  author?: string;
  x: number;
  y: number;
  angle: number;
  mass?: number;
}

/** Spawns a snake, then moves it to an exact pose with its body straight behind it. */
export function place(world: World, o: PlaceOptions): Snake {
  const c = world.config;
  const snake = spawnSnake(world, { id: o.id, author: o.author ?? o.id });
  const mass = o.mass ?? c.startMass;
  snake.mass = mass;
  snake.maxMass = mass;
  snake.size = sizeForMass(mass, c);
  snake.angle = o.angle;
  const count = segmentCountForMass(mass, c);
  const len = (count - 1) * snake.size;
  snake.trail = [
    { x: o.x - cos(o.angle) * len, y: o.y - sin(o.angle) * len },
    { x: o.x, y: o.y },
  ];
  snake.segments = [];
  layoutSegments(snake, count);
  return snake;
}

/** No food, no hunger: isolates mechanics under test. */
export const QUIET = { foodBase: 0, foodPerSnake: 0, hungerFlat: 0, hungerRate: 0 } as const;
