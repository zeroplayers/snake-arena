import { describe, expect, it } from "vitest";
import { checkSource } from "./source.ts";

describe("checkSource", () => {
  it("rejects BigInt literals anywhere", () => {
    for (const src of ["const x = 10n;", "f(0x1fn)", "a=1_000n", "x = 0b101n", "// 5n", "'1n'"]) {
      expect(checkSource(src), src).toMatch(/BigInt is not available/);
    }
    expect(checkSource("a\nb\nconst x = 2n;")).toBe(
      'BigInt is not available to bots (found "2n" on line 3)',
    );
  });

  it("accepts ordinary code", () => {
    for (const src of ["const n1n = 1; x1n + 2", "'2nd place'", "1e5", "a.n", "$1n", "0x1f + n"]) {
      expect(checkSource(src), src).toBeNull();
    }
  });
});
