import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG as C } from "./config";
import { hungerDecay, lifeScore, segmentCountForMass, sizeForMass } from "./growth";
import { step } from "./step";
import { actionsFor, circle, farm, type Policy } from "./testing/policies";
import { place, QUIET } from "./testing/setup";
import type { Death } from "./types";
import { createWorld, spawnSnake } from "./world";

describe("growth formulas", () => {
  it("size grows linearly with mass from minSize to maxSize", () => {
    expect(sizeForMass(0, C)).toBe(C.minSize);
    expect(sizeForMass(C.sizeMassCap / 2, C)).toBe((C.minSize + C.maxSize) / 2);
    expect(sizeForMass(C.sizeMassCap * 3, C)).toBe(C.maxSize);
  });

  it("segment count follows the original floor(mass × 0.1 / size + 5)", () => {
    expect(segmentCountForMass(0, C)).toBe(5);
    expect(segmentCountForMass(10, C)).toBe(5); // 10 × 0.1 / 1.004 = 0.996
    expect(segmentCountForMass(100, C)).toBe(14);
    expect(segmentCountForMass(1000, C)).toBe(76);
    expect(segmentCountForMass(10_000, C)).toBe(205);
  });

  it("a fed snake grows a longer, thicker body", () => {
    const world = createWorld({ seed: 1, config: QUIET });
    const s = place(world, { id: "a", x: 0, y: 0, angle: 0 });
    const before = s.segments.length;
    for (let k = 0; k < 20; k++)
      world.food.push({ id: 1000 + k, x: 3 + k * 1.5, y: 0, value: 10, kind: "ambient" });
    for (let t = 0; t < 25; t++) step(world, {});
    expect(s.mass).toBe(C.startMass + 200);
    expect(s.segments.length).toBe(segmentCountForMass(s.mass, C));
    expect(s.segments.length).toBeGreaterThan(before + 10);
    expect(s.size).toBeGreaterThan(sizeForMass(C.startMass, C));
  });
});

describe("hunger", () => {
  it("mass decays every tick, faster when larger, never below minMass", () => {
    expect(hungerDecay(100, C)).toBeCloseTo(100 - C.hungerFlat - 100 * C.hungerRate, 12);
    expect(100 - hungerDecay(100, C)).toBeLessThan(1000 - hungerDecay(1000, C));
    expect(hungerDecay(C.minMass, C)).toBe(C.minMass);
  });

  it("a starving snake shrinks", () => {
    const world = createWorld({ seed: 1, config: { foodBase: 0, foodPerSnake: 0 } });
    const s = place(world, { id: "a", x: 0, y: 0, angle: 0, mass: 1000 });
    for (let t = 0; t < 1000; t++) step(world, { a: { turn: 1 } });
    expect(s.mass).toBeLessThan(800);
    expect(s.segments.length).toBe(segmentCountForMass(s.mass, C));
  });
});

describe("life score", () => {
  it("is the area under the mass curve plus kill bonus", () => {
    expect(lifeScore(5000, 2, C)).toBe(5000 * C.massScoreFactor + 2 * C.killBonus);
    const world = createWorld({ seed: 1, config: QUIET });
    const s = place(world, { id: "a", x: 0, y: 0, angle: 0, mass: 40 });
    for (let t = 0; t < 30; t++) step(world, { a: { turn: 1 } });
    expect(s.massArea).toBe(40 * 30);
    expect(s.score).toBeCloseTo(40 * 30 * C.massScoreFactor, 12);
  });

  /** One full life (to the life cap) of a single policy, alone in a normal arena. */
  const life = (policy: Policy, seed: number): Death => {
    const world = createWorld({ seed });
    spawnSnake(world, { id: "a", author: "a" });
    while (world.snakes.length > 0) step(world, actionsFor(world, { a: policy }));
    const [death] = world.deaths;
    if (!death) throw new Error("no death");
    return death;
  };

  it("circling in place scores far below farming food", () => {
    for (const seed of [1, 2, 3]) {
      const lazy = life(circle, seed);
      const farmer = life(farm, seed);
      expect(lazy.cause).toBe("retired");
      expect(farmer.cause).toBe("retired");
      expect(lazy.score * 5).toBeLessThan(farmer.score);
    }
  });
});
