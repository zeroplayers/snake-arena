import { describe, expect, it } from "vitest";
import { createHeroSource } from "./heroSource";

describe("createHeroSource", () => {
  it("plays the live showcase when there is one", async () => {
    const { LiveEngineSource } = await import("@zerosnake/viewer");
    const showcase = new LiveEngineSource({ bots: [], seed: 1 });
    const hero = await createHeroSource({ live: async () => showcase });
    expect(hero).toEqual({ source: showcase, live: true });
  });

  it("falls back to a house-bot match a few hundred ticks in, and keeps going", async () => {
    const { source, live } = await createHeroSource({
      seed: 7,
      live: () => Promise.reject(new Error("no showcase room")),
    });
    expect(live).toBe(false);
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

  it("falls back where there is no WebSocket to the site (server render, tests)", async () => {
    const { live } = await createHeroSource({ seed: 1 });
    expect(live).toBe(false);
  });
});
