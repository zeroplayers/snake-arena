import { describe, expect, it } from "vitest";
import { LiveEngineSource } from "./live/LiveEngineSource.ts";
import { Playback } from "./Playback.ts";
import type { LifeInfo, MatchSource, TickSnapshot } from "./types.ts";

const spinner = { name: "spinner", act: () => ({ turn: 1 }) };

/** A finished recording of ticks 0..end, as a replay source would look. */
function recording(end: number, lives: LifeInfo[] = []): MatchSource & { requested: number[] } {
  const requested: number[] = [];
  const snap = (tick: number): TickSnapshot => ({
    tick,
    frame: { tick, arenaHalfSize: 89, snakes: [], food: [] },
    snakes: [],
    deaths: [],
  });
  return {
    info: { tps: 10, arenaHalfSize: 89, visionRadius: 30 },
    firstTick: 0,
    lastTick: end,
    endTick: end,
    requested,
    request: (t) => requested.push(t),
    snapshot: (t) => (Number.isInteger(t) && t >= 0 && t <= end ? snap(t) : undefined),
    lives: () => lives,
    life: (id) => lives.find((l) => l.id === id),
  };
}

describe("Playback", () => {
  it("advances at tps × speed and simulates a live source just in time", () => {
    const source = new LiveEngineSource({ bots: [spinner], seed: 1 });
    const p = new Playback(source);
    p.update(0.25);
    expect(p.position).toBeCloseTo(2.5);
    expect(source.lastTick).toBe(3);
    p.setSpeed(4);
    p.update(0.5);
    expect(p.position).toBeCloseTo(22.5);
    expect(source.lastTick).toBe(23);
    expect(p.atLiveEdge).toBe(true);
  });

  it("does not move or simulate while paused", () => {
    const source = new LiveEngineSource({ bots: [spinner], seed: 1 });
    const p = new Playback(source);
    p.pause();
    p.update(1);
    expect(p.position).toBe(0);
    expect(source.lastTick).toBe(0);
  });

  it("scrubs back through simulated ticks and plays forward again", () => {
    const source = new LiveEngineSource({ bots: [spinner], seed: 1 });
    const p = new Playback(source);
    source.request(100);
    p.seek(40);
    expect(p.tick).toBe(40);
    expect(p.atLiveEdge).toBe(false);
    p.update(0.1);
    expect(p.position).toBeCloseTo(41);
    expect(source.lastTick).toBe(100);
    p.seek(-5);
    expect(p.position).toBe(0);
  });

  it("steps tick by tick and pauses", () => {
    const source = new LiveEngineSource({ bots: [spinner], seed: 1 });
    const p = new Playback(source);
    p.update(0.33);
    p.stepBy(1);
    expect(p.position).toBe(4);
    expect(p.isPaused).toBe(true);
    p.stepBy(-10);
    expect(p.position).toBe(0);
  });

  it("goes live from anywhere", () => {
    const source = new LiveEngineSource({ bots: [spinner], seed: 1 });
    const p = new Playback(source);
    source.request(50);
    p.seek(10);
    p.pause();
    p.goLive();
    expect(p.isPaused).toBe(false);
    expect(p.position).toBe(50);
  });

  it("samples whole ticks on their own and blends in between", () => {
    const source = new LiveEngineSource({ bots: [spinner], seed: 1 });
    const p = new Playback(source);
    source.request(10);
    p.seek(5);
    const whole = p.sample();
    expect(whole?.prev.tick).toBe(5);
    expect(whole?.next.tick).toBe(5);
    p.seek(5.25);
    const mid = p.sample();
    expect([mid?.prev.tick, mid?.next.tick, mid?.alpha]).toEqual([5, 6, 0.25]);
  });

  it("plays the lead-up to a death and stops on the last tick alive", () => {
    const lives: LifeInfo[] = [
      {
        id: "a#1",
        bot: "a",
        author: "a",
        color: "#ff0000",
        bornTick: 10,
        death: { tick: 100, cause: "wall", killerId: null, score: 1, mass: 10, kills: 0 },
      },
      { id: "b#1", bot: "b", author: "b", color: "#00ff00", bornTick: 0 },
    ];
    const p = new Playback(recording(200, lives));
    expect(p.jumpToDeath("b#1")).toBe(false);
    expect(p.jumpToDeath("a#1", 30)).toBe(true);
    expect(p.position).toBe(69);
    expect(p.isPaused).toBe(false);
    p.update(2);
    expect(p.position).toBe(89);
    p.update(2);
    expect(p.position).toBe(99);
    expect(p.isPaused).toBe(true);
    p.play();
    p.update(0.1);
    expect(p.position).toBeCloseTo(100);
  });

  it("never seeks before a life's spawn when jumping to its death", () => {
    const lives: LifeInfo[] = [
      {
        id: "a#1",
        bot: "a",
        author: "a",
        color: "#ff0000",
        bornTick: 90,
        death: { tick: 100, cause: "wall", killerId: null, score: 1, mass: 10, kills: 0 },
      },
    ];
    const p = new Playback(recording(200, lives));
    p.jumpToDeath("a#1");
    expect(p.position).toBe(90);
  });

  it("stops at the end of a recording and restarts on play", () => {
    const source = recording(20);
    const p = new Playback(source);
    p.update(5);
    expect(p.position).toBe(20);
    expect(p.isPaused).toBe(true);
    expect(p.atLiveEdge).toBe(false);
    expect(Math.max(...source.requested)).toBeLessThanOrEqual(20);
    p.play();
    expect(p.position).toBe(0);
  });

  it("cycles through the speed steps", () => {
    const p = new Playback(recording(10));
    p.stepSpeed(1);
    expect(p.speed).toBe(2);
    p.stepSpeed(-1);
    p.stepSpeed(-1);
    expect(p.speed).toBe(0.5);
    p.setSpeed(0);
    expect(p.speed).toBe(0.5);
  });
});
