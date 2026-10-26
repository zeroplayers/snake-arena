import v8 from "node:v8";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { coward, forager, hunter, wanderer } from "../../demo/bots.ts";
import { DEFAULT_VISION_RADIUS, type LiveBot, LiveEngineSource } from "./LiveEngineSource.ts";

/**
 * Retained heap of a long live match. `VIEWER_BENCH_TICKS=18000` runs the full default
 * history (slow); the default keeps the suite fast and checks the per-tick cost.
 */
const TICKS = Number(process.env.VIEWER_BENCH_TICKS ?? 2000);
const SNAKES = 20;

v8.setFlagsFromString("--expose_gc");
const gc = vm.runInNewContext("gc") as () => void;

function heap(): number {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

function bots(): LiveBot[] {
  const makers = [
    (n: string) => forager(n, DEFAULT_VISION_RADIUS),
    (n: string) => hunter(n, DEFAULT_VISION_RADIUS),
    (n: string) => coward(n, DEFAULT_VISION_RADIUS),
    (n: string) => wanderer(n),
  ];
  return Array.from({ length: SNAKES }, (_, i) =>
    (makers[i % 4] as (n: string) => LiveBot)(`b${i}`),
  );
}

describe("LiveEngineSource memory", () => {
  it(`retains a few KB per tick with ${SNAKES} snakes`, () => {
    const before = heap();
    const source = new LiveEngineSource({ bots: bots(), seed: 11, maxTicks: 18_000 });
    source.request(TICKS);
    const used = heap() - before;
    const perTick = used / TICKS;
    const segments = source.world.snakes.reduce((n, s) => n + s.segments.length, 0);
    console.log(
      `${TICKS} ticks, ${source.world.snakes.length} snakes, ${segments} segments, ` +
        `${source.world.food.length} food: ${(used / 1e6).toFixed(1)} MB, ` +
        `${(perTick / 1024).toFixed(2)} KB/tick, ${((perTick * 18_000) / 1e6).toFixed(0)} MB at 18k`,
    );
    expect(source.snapshot(TICKS)).toBeDefined();
    // ~2.4 KB today (was ~42 KB with a full copy per tick); the margin absorbs GC noise.
    expect(perTick).toBeLessThan(3.5 * 1024);
  }, 120_000);

  it("rebuilds a random past tick in a few milliseconds", () => {
    const source = new LiveEngineSource({ bots: bots(), seed: 12 });
    source.request(TICKS);
    const picks = Array.from({ length: 50 }, (_, i) => (i * 7919) % TICKS);
    const t0 = performance.now();
    for (const t of picks) expect(source.snapshot(t)?.tick).toBe(t);
    const ms = (performance.now() - t0) / picks.length;
    console.log(`random seek: ${ms.toFixed(2)} ms per tick`);
    expect(ms).toBeLessThan(50);
  });
});
