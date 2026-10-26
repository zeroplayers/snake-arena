import { DEFAULT_CONFIG, type EngineConfig } from "@zerosnake/engine";
import { describe, expect, it } from "vitest";
import { KEYFRAME_INTERVAL, type LiveBot, LiveEngineSource } from "./LiveEngineSource.ts";

/** Spawns facing the centre and never turns, so it crosses the arena and hits the wall. */
const straight: LiveBot = {
  name: "straight",
  act: (snake, _world, log) => {
    log(`at ${snake.head.x.toFixed(1)},${snake.head.y.toFixed(1)}`);
    return { turn: 0 };
  },
};

const spinner: LiveBot = { name: "spinner", act: () => ({ turn: 1, boost: false }) };

describe("LiveEngineSource", () => {
  it("starts with tick 0 and simulates only what is requested", () => {
    const source = new LiveEngineSource({ bots: [spinner], seed: 1 });
    expect(source.firstTick).toBe(0);
    expect(source.lastTick).toBe(0);
    expect(source.snapshot(0)?.snakes.map((s) => s.id)).toEqual(["spinner#1"]);
    source.request(25);
    expect(source.lastTick).toBe(25);
    expect(source.snapshot(25)?.tick).toBe(25);
    expect(source.snapshot(26)).toBeUndefined();
    expect(source.snapshot(2.5)).toBeUndefined();
  });

  it("is deterministic for a seed", () => {
    const run = () => {
      const source = new LiveEngineSource({ bots: [spinner, straight], seed: 9 });
      source.request(60);
      return source.snapshot(60)?.frame;
    };
    expect(run()).toEqual(run());
  });

  it("rebuilds past ticks exactly as they were simulated", () => {
    const bots = [spinner, straight, { ...straight, name: "other" }];
    const live = new LiveEngineSource({ bots, seed: 8, respawnDelay: 3 });
    const seen: unknown[] = [live.snapshot(0)];
    for (let t = 1; t <= 450; t++) {
      live.request(t);
      seen.push(structuredClone(live.snapshot(t)));
    }
    expect(live.lives().some((l) => l.death)).toBe(true);
    // Backwards, so nearly every tick misses the cache and is re-simulated from a keyframe.
    for (let t = 450; t >= 0; t--) expect(live.snapshot(t), `tick ${t}`).toEqual(seen[t]);
    for (let t = 0; t <= 450; t++) expect(live.snapshot(t), `tick ${t}`).toEqual(seen[t]);
  });

  it("takes the vision radius from the engine config when it has one", () => {
    expect(new LiveEngineSource({ bots: [] }).info.visionRadius).toBe(DEFAULT_CONFIG.visionRadius);
    const config = { visionRadius: 35 } as Partial<EngineConfig>;
    expect(new LiveEngineSource({ bots: [], config }).info.visionRadius).toBe(35);
    expect(new LiveEngineSource({ bots: [], config, visionRadius: 25 }).info.visionRadius).toBe(25);
  });

  it("keeps old snapshots intact while the world moves on", () => {
    const source = new LiveEngineSource({ bots: [spinner], seed: 2 });
    source.request(5);
    const before = structuredClone(source.snapshot(5));
    source.request(50);
    expect(source.snapshot(5)).toEqual(before);
  });

  it("attaches each tick's action and log lines to the snapshot the bot saw", () => {
    const source = new LiveEngineSource({ bots: [straight, spinner], seed: 3 });
    source.request(3);
    const tick = source.snapshot(3);
    const s = tick?.snakes.find((x) => x.id === "straight#1");
    const head = tick?.frame.snakes.find((x) => x.id === "straight#1")?.segments[0];
    expect(s?.action).toEqual({ turn: 0, boost: false });
    expect(s?.logs).toEqual([`at ${head?.x.toFixed(1)},${head?.y.toFixed(1)}`]);
    expect(tick?.snakes.find((x) => x.id === "spinner#1")?.action).toEqual({
      turn: 1,
      boost: false,
    });
  });

  it("records deaths and respawns the bot as a new life", () => {
    const source = new LiveEngineSource({ bots: [straight], seed: 4, respawnDelay: 5 });
    source.request(400);
    const first = source.life("straight#1");
    expect(first?.death?.cause).toBe("wall");
    const deathTick = first?.death?.tick as number;
    expect(source.snapshot(deathTick)?.deaths).toEqual(["straight#1"]);
    expect(source.snapshot(deathTick)?.snakes).toEqual([]);
    expect(source.snapshot(deathTick - 1)?.snakes.map((s) => s.id)).toEqual(["straight#1"]);
    expect(source.life("straight#2")?.bornTick).toBe(deathTick + 5);
    expect(source.lives()[0]?.id).toBe("straight#1");
  });

  it("logs a throwing bot's error and keeps it going straight", () => {
    const broken: LiveBot = {
      name: "broken",
      act: () => {
        throw new Error("boom");
      },
    };
    const source = new LiveEngineSource({ bots: [broken], seed: 5 });
    const s = source.snapshot(0)?.snakes[0];
    expect(s?.action).toEqual({ turn: 0, boost: false });
    expect(s?.logs).toEqual(["error: boom"]);
  });

  it("drops the oldest snapshots past maxTicks", () => {
    const source = new LiveEngineSource({ bots: [spinner], seed: 6, maxTicks: 10 });
    source.request(1000);
    expect(source.lastTick).toBe(1000);
    expect(source.firstTick).toBeGreaterThan(0);
    expect(source.lastTick - source.firstTick).toBeLessThan(10 + KEYFRAME_INTERVAL);
    expect(source.snapshot(source.firstTick - 1)).toBeUndefined();
    expect(source.snapshot(source.firstTick)?.tick).toBe(source.firstTick);
  });

  it("shares unchanged pellets between snapshots", () => {
    const source = new LiveEngineSource({ bots: [spinner], seed: 7 });
    source.request(1);
    const a = source.snapshot(0)?.frame.food ?? [];
    const b = new Set(source.snapshot(1)?.frame.food ?? []);
    expect(a.filter((f) => b.has(f)).length).toBeGreaterThan(a.length / 2);
  });
});
