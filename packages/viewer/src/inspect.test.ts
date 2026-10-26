import { describe, expect, it } from "vitest";
import { lifeAt, pickSnake, ranking, recentDeaths, recentLogs } from "./inspect.ts";
import { type LiveBot, LiveEngineSource } from "./live/LiveEngineSource.ts";

const straight: LiveBot = {
  name: "straight",
  act: (snake, _world, log) => {
    if (snake.lifeTick % 2 === 0) log(`life tick ${snake.lifeTick}`);
    return { turn: 0 };
  },
};
const spinner: LiveBot = { name: "spinner", act: () => ({ turn: 1 }) };

function match() {
  const source = new LiveEngineSource({ bots: [straight, spinner], seed: 4, respawnDelay: 5 });
  source.request(400);
  const death = source.life("straight#1")?.death?.tick as number;
  return { source, death };
}

describe("inspect", () => {
  it("tells where a life stands on a tick", () => {
    const { source, death } = match();
    const born = source.life("straight#2")?.bornTick as number;
    expect(lifeAt(source, "straight#1", source.snapshot(death - 1)).kind).toBe("alive");
    expect(lifeAt(source, "straight#1", source.snapshot(death)).kind).toBe("dead");
    expect(lifeAt(source, "straight#2", source.snapshot(born - 1)).kind).toBe("unborn");
    expect(lifeAt(source, "nobody", source.snapshot(0)).kind).toBe("unknown");
  });

  it("collects a life's recent log lines up to a tick, oldest first", () => {
    const { source } = match();
    const logs = recentLogs(source, "straight#1", 10, 3);
    expect(logs.map((l) => l.tick)).toEqual([6, 8, 10]);
    expect(logs[2]?.lines).toEqual(["life tick 10"]);
    expect(recentLogs(source, "spinner#1", 10)).toEqual([]);
  });

  it("ranks living snakes by score and lists deaths newest first", () => {
    const { source, death } = match();
    const ranked = ranking(source.snapshot(death - 1));
    expect(ranked.map((s) => s.id).sort()).toEqual(["spinner#1", "straight#1"]);
    expect(ranked[0]?.score).toBeGreaterThanOrEqual(ranked[1]?.score ?? 0);
    expect(recentDeaths(source, death - 1, 5)).toEqual([]);
    expect(recentDeaths(source, death, 5).map((l) => l.id)).toEqual(["straight#1"]);
  });

  it("picks the snake under a point", () => {
    const { source } = match();
    const snap = source.snapshot(0);
    const spinner = snap?.frame.snakes.find((s) => s.id === "spinner#1");
    const tail = spinner?.segments[spinner.segments.length - 1] ?? { x: 0, y: 0 };
    expect(pickSnake(snap, tail, 0.5)).toBe("spinner#1");
    expect(pickSnake(snap, { x: 1000, y: 1000 }, 0.5)).toBeUndefined();
  });
});
