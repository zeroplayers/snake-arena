import { createWorld, type Snake, spawnSnake, step } from "@zerosnake/engine";
import { interpolateSnake, type RenderSnake, resamplePolyline } from "@zerosnake/renderer";
import { describe, expect, it } from "vitest";

/** As the viewer's sources hand snakes to the renderer. */
const toRender = (snake: Snake): RenderSnake => ({
  id: snake.id,
  segments: snake.segments.map((p) => ({ x: p.x, y: p.y })),
  angle: snake.angle,
  length: snake.segments.length,
  radius: snake.size / 2,
});

/** The tail the renderer draws `alpha` of the way from one tick to the next. */
function drawnTail(prev: RenderSnake, next: RenderSnake, alpha: number): { x: number; y: number } {
  const state = interpolateSnake(prev, next, alpha, {
    points: [],
    pathLength: 0,
    bodyLength: 0,
    blended: false,
    angle: 0,
    radius: 0,
    length: 0,
  });
  const out: number[] = [];
  const n = resamplePolyline(state.points, state.radius * 1.4, out, state.bodyLength);
  return { x: out[2 * n - 2] as number, y: out[2 * n - 1] as number };
}

describe("engine snakes in the renderer", () => {
  // A huge snake in a tight turn, growing: its segments are 4.5 apart on a ~12-unit circle, so
  // two ticks cut the bends quite differently, and the body outgrows its trail, piling the tail.
  it.each([
    { turn: 0.5, growth: 20 },
    { turn: 1, growth: 5 },
    { turn: 1, growth: 0 },
  ])(
    "ends each tick's blend on the next tick's tail (turn $turn, +$growth mass/tick)",
    ({ turn, growth }) => {
      const world = createWorld({
        seed: 1,
        config: {
          arenaHalfSize: 5000,
          foodBase: 0,
          foodSpawnPerTick: 0,
          hungerFlat: 0,
          hungerRate: 0,
        },
      });
      const snake = spawnSnake(world, { id: "a", author: "a" });
      snake.mass = 8750;
      for (let t = 0; t < 1000; t++) step(world, { a: { turn } });

      let prev = toRender(world.snakes[0] as Snake);
      for (let t = 0; t < 40; t++) {
        (world.snakes[0] as Snake).mass += growth;
        step(world, { a: { turn } });
        const next = toRender(world.snakes[0] as Snake);
        const start = drawnTail(prev, next, 0);
        const end = drawnTail(prev, next, 1);
        const prevTail = prev.segments.at(-1) as { x: number; y: number };
        const nextTail = next.segments.at(-1) as { x: number; y: number };
        // Blending path lengths instead missed it by up to 1.1, 3.0 and 0.4 in these cases,
        // and the tail snapped there when the next tick began.
        expect(Math.hypot(start.x - prevTail.x, start.y - prevTail.y)).toBeLessThan(1e-6);
        expect(Math.hypot(end.x - nextTail.x, end.y - nextTail.y)).toBeLessThan(1e-6);
        prev = next;
      }
    },
  );
});
