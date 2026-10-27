import { createRng } from "@zerosnake/engine";
import { describe, expect, it } from "vitest";
import { disguiseFor, userId } from "./disguise.ts";

const SEEDS = Array.from({ length: 2000 }, (_, i) => (i * 2654435761) >>> 0);

describe("check rooms are set up like arena rooms", () => {
  const rooms = SEEDS.map((seed) => disguiseFor(seed));

  it("are the same for the same seed", () => {
    expect(JSON.stringify(disguiseFor(42))).toBe(JSON.stringify(disguiseFor(42)));
    expect(disguiseFor(42).candidate.lifeId(3)).toBe(disguiseFor(42).candidate.lifeId(3));
  });

  it("start at tick 0 about half the time, the rest spread over every power of ten", () => {
    const fresh = rooms.filter((r) => r.startTick === 0).length / rooms.length;
    expect(fresh).toBeGreaterThan(0.45);
    expect(fresh).toBeLessThan(0.55);
    const digits = new Map<number, number>();
    for (const r of rooms) {
      if (r.startTick === 0) continue;
      const d = String(r.startTick).length;
      digits.set(d, (digits.get(d) ?? 0) + 1);
    }
    expect([...digits.keys()].sort()).toEqual([4, 5, 6, 7]);
    for (const n of digits.values()) expect(n / rooms.length).toBeGreaterThan(0.1);
  });

  it("let the candidate open a young room only when no other ticket did", () => {
    for (const r of rooms) {
      if (r.startTick === 0 && r.users.length === 0) expect(r.preroll).toBe(0);
    }
    const young = rooms.filter((r) => r.startTick === 0 && r.users.length > 0);
    expect(young.some((r) => r.preroll === 0)).toBe(true);
    expect(young.some((r) => r.preroll >= 100)).toBe(true);
  });

  it("give users Better Auth ids and every life a UUID", () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const r of rooms.slice(0, 100)) {
      for (const identity of [r.candidate, ...r.users.map((u) => u.identity)]) {
        expect(identity.author).toMatch(/^[A-Za-z0-9]{32}$/);
        expect(identity.lifeId(0)).toMatch(uuid);
        expect(identity.lifeId(1)).not.toBe(identity.lifeId(0));
      }
    }
  });

  it("draw user ids from all 62 letters and digits", () => {
    const rng = createRng(7);
    const seen = new Set(Array.from({ length: 200 }, () => userId(rng)).join(""));
    expect(seen.size).toBe(62);
  });
});
