import { describe, expect, it } from "vitest";
import { createConfig, DEFAULT_CONFIG, rulesId, sameRules } from "./config.ts";

describe("sameRules", () => {
  it("tells configs apart by any rule, but not by internals", () => {
    expect(sameRules(createConfig(), DEFAULT_CONFIG)).toBe(true);
    expect(sameRules(createConfig({ gridCellSize: 16 }), DEFAULT_CONFIG)).toBe(true);
    expect(sameRules(createConfig({ turnRate: 0.25 }), DEFAULT_CONFIG)).toBe(false);
    expect(sameRules(createConfig({ foodBase: 1 }), DEFAULT_CONFIG)).toBe(false);
  });

  it("counts a key only one side has as a difference", () => {
    const { arenaHalfSize: _, ...rest } = DEFAULT_CONFIG;
    const old = { ...rest, arenaRadius: 100 } as unknown as typeof DEFAULT_CONFIG;
    expect(sameRules(old, DEFAULT_CONFIG)).toBe(false);
    expect(sameRules(DEFAULT_CONFIG, old)).toBe(false);
  });
});

describe("rulesId", () => {
  it("fingerprints the rules alone", () => {
    expect(rulesId(DEFAULT_CONFIG)).toMatch(/^[0-9a-f]{8}$/);
    expect(rulesId(createConfig({ gridCellSize: 16 }))).toBe(rulesId(DEFAULT_CONFIG));
    expect(rulesId(createConfig({ turnRate: 0.25 }))).not.toBe(rulesId(DEFAULT_CONFIG));
  });
});
