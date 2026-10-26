import { describe, expect, it } from "vitest";
import { createRng } from "./rng.ts";

const take = (n: number, f: () => number) => Array.from({ length: n }, f);

describe("createRng", () => {
  it("is deterministic for a seed", () => {
    const a = createRng(42);
    const b = createRng(42);
    expect(take(100, a.next)).toEqual(take(100, b.next));
  });

  it("diverges for different seeds", () => {
    expect(createRng(1).next()).not.toBe(createRng(2).next());
  });

  it("stays in range", () => {
    const rng = createRng(7);
    for (const x of take(10_000, rng.next)) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    for (const x of take(1000, () => rng.int(5))) {
      expect(Number.isInteger(x) && x >= 0 && x < 5).toBe(true);
    }
  });

  it("forks reproducibly", () => {
    const a = createRng(9).fork();
    const b = createRng(9).fork();
    expect(take(10, a.next)).toEqual(take(10, b.next));
  });
});
