import { DEFAULT_CONFIG } from "@zerosnake/engine";
import { describe, expect, it } from "vitest";
import { foodDisplaySize, REMAINS_DISPLAY_SCALE } from "./food.ts";
import { type LiveBot, LiveEngineSource } from "./live/LiveEngineSource.ts";

describe("foodDisplaySize", () => {
  it("draws ambient and boost food at the engine's food radius", () => {
    expect(foodDisplaySize("ambient", DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.foodRadius);
    expect(foodDisplaySize("boost", DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.foodRadius);
  });

  it("draws remains as slightly bigger food, not at their gameplay radius", () => {
    const remains = foodDisplaySize("remains", DEFAULT_CONFIG);
    expect(remains).toBeCloseTo(DEFAULT_CONFIG.foodRadius * REMAINS_DISPLAY_SCALE, 12);
    expect(remains / DEFAULT_CONFIG.foodRadius).toBeGreaterThanOrEqual(1.5);
    expect(remains / DEFAULT_CONFIG.foodRadius).toBeLessThanOrEqual(2);
    expect(remains).toBeLessThan(DEFAULT_CONFIG.remainsRadius);
  });

  it("follows the configured food radius", () => {
    expect(foodDisplaySize("remains", { foodRadius: 2 })).toBeCloseTo(2 * REMAINS_DISPLAY_SCALE);
  });
});

describe("LiveEngineSource food", () => {
  it("sizes pellets with foodDisplaySize", () => {
    const wall: LiveBot = { name: "wall", act: () => ({ turn: 0 }) };
    const source = new LiveEngineSource({ bots: [wall], seed: 3 });
    source.request(400);
    const death = source.life("wall#1")?.death?.tick as number;
    expect(death).toBeGreaterThan(0);
    const sizes = (source.snapshot(death)?.frame.food ?? []).map((f) => f.size);
    const ambient = foodDisplaySize("ambient", DEFAULT_CONFIG);
    const remains = foodDisplaySize("remains", DEFAULT_CONFIG);
    expect(sizes).toContain(remains);
    expect(sizes.every((s) => s === ambient || s === remains)).toBe(true);
  });
});
