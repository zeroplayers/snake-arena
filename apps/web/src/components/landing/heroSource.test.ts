import { describe, expect, it } from "vitest";
import { createHeroSource } from "./heroSource";

describe("createHeroSource", () => {
  it("starts a house-bot match a few hundred ticks in, and keeps going", async () => {
    const source = await createHeroSource(7);
    expect(source.endTick).toBeUndefined();
    expect(source.lastTick).toBeGreaterThanOrEqual(300);
    const bots = new Set(source.lives().map((l) => l.bot));
    expect(bots.size).toBe(8);

    const tick = source.lastTick + 100;
    source.request(tick);
    const snap = source.snapshot(tick);
    expect(snap?.frame.snakes.length).toBeGreaterThan(0);
    expect(snap?.frame.arenaRadius).toBe(38);
  });
});
