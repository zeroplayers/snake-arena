import type { RenderFood, RenderFrame, RenderSnake, Vec2 } from "../src";

/**
 * Stand-in for the engine so the renderer can be developed on its own: snakes wander,
 * steer away from the wall, chase food, grow, and die (dropping food) when they hit the wall.
 * Not the real physics, just enough motion to exercise the renderer.
 */

const STEP = 0.9; // distance per tick, also the spacing of path points
const MAX_TURN = 0.22; // rad per tick
const FOOD_TARGET = 320;

interface Snake {
  id: string;
  path: Vec2[]; // head first, one point per tick of travel
  angle: number;
  wander: number;
  length: number; // in path points
  color: string | undefined;
}

export class FakeWorld {
  tick = 0;
  readonly arenaRadius = 80;
  private snakes: Snake[] = [];
  private food: RenderFood[] = [];
  private nextFoodId = 0;
  private readonly random: () => number;

  constructor(snakeCount = 12, seed = 1) {
    this.random = mulberry32(seed);
    for (let i = 0; i < snakeCount; i++)
      this.snakes.push(this.spawn(`bot-${i}`, i === 0 ? "#BFFF00" : undefined));
    while (this.food.length < FOOD_TARGET) this.food.push(this.makeFood(this.randomPoint(0.97)));
  }

  get snakeIds(): string[] {
    return this.snakes.map((s) => s.id);
  }

  step(): void {
    this.tick++;
    for (const [i, s] of this.snakes.entries()) {
      const head = s.path[0] as Vec2;
      const radius = 0.8 + Math.sqrt(s.length) * 0.08;

      s.wander += (this.random() - 0.5) * 0.15;
      s.wander = Math.max(-1, Math.min(1, s.wander));
      let turn = s.wander * MAX_TURN * 0.6;

      // Chase the nearest food in front, if any is close.
      const target = this.nearestFood(head, 14);
      if (target)
        turn += angleDiff(s.angle, Math.atan2(target.y - head.y, target.x - head.x)) * 0.5;

      // Steer back towards the centre near the wall (sometimes too late, on purpose).
      const dist = Math.hypot(head.x, head.y);
      if (dist > this.arenaRadius - 14)
        turn += angleDiff(s.angle, Math.atan2(-head.y, -head.x)) * 0.35;

      s.angle += Math.max(-MAX_TURN, Math.min(MAX_TURN, turn));
      const next = { x: head.x + Math.cos(s.angle) * STEP, y: head.y + Math.sin(s.angle) * STEP };
      s.path.unshift(next);
      if (s.path.length > s.length) s.path.length = Math.floor(s.length);

      if (Math.hypot(next.x, next.y) + radius > this.arenaRadius) {
        this.kill(i);
        continue;
      }
      this.eat(s, next, radius);
    }
    while (this.food.length < FOOD_TARGET) this.food.push(this.makeFood(this.randomPoint(0.97)));
  }

  /** Immutable snapshot: the renderer keeps a few frames around to interpolate. */
  frame(): RenderFrame {
    const snakes: RenderSnake[] = this.snakes.map((s) => ({
      id: s.id,
      segments: s.path.map((p) => ({ x: p.x, y: p.y })),
      angle: s.angle,
      length: s.length,
      ...(s.color && { skin: { color: s.color } }),
    }));
    return { tick: this.tick, arenaRadius: this.arenaRadius, snakes, food: [...this.food] };
  }

  private eat(s: Snake, head: Vec2, radius: number): void {
    const reach = radius + 0.6;
    this.food = this.food.filter((f) => {
      if (Math.hypot(f.x - head.x, f.y - head.y) > reach + f.size) return true;
      s.length += f.size * 3;
      return false;
    });
  }

  private kill(index: number): void {
    const dead = this.snakes[index] as Snake;
    for (const [i, p] of dead.path.entries()) {
      if (i % 3 === 0) this.food.push(this.makeFood(p, 0.6));
    }
    this.snakes[index] = this.spawn(dead.id, dead.color);
  }

  private spawn(id: string, color: string | undefined): Snake {
    const start = this.randomPoint(0.6);
    const angle = this.random() * Math.PI * 2;
    const length = 25 + Math.floor(this.random() * 80);
    // Lay the initial body out straight behind the head.
    const path = Array.from({ length }, (_, i) => ({
      x: start.x - Math.cos(angle) * STEP * i,
      y: start.y - Math.sin(angle) * STEP * i,
    }));
    return { id, path, angle, wander: 0, length, color };
  }

  private makeFood(at: Vec2, size = 0.3 + this.random() * 0.25): RenderFood {
    return { id: this.nextFoodId++, x: at.x, y: at.y, size };
  }

  private nearestFood(p: Vec2, maxDist: number): RenderFood | undefined {
    let best: RenderFood | undefined;
    let bestD = maxDist;
    for (const f of this.food) {
      const d = Math.hypot(f.x - p.x, f.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    return best;
  }

  private randomPoint(fraction: number): Vec2 {
    const r = Math.sqrt(this.random()) * this.arenaRadius * fraction;
    const a = this.random() * Math.PI * 2;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  }
}

function angleDiff(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
