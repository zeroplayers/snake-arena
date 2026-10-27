import { describe, expect, it } from "vitest";
import { formatBytes, LIMITS, measureLimits } from "./limits.ts";

const files = (n: number, bytes: number) =>
  Array.from({ length: n }, (_, i) => ({ path: `src/f${i}.ts`, bytes }));

describe("measureLimits", () => {
  it("accepts an artifact exactly at every limit", () => {
    const { problems, details } = measureLimits("x".repeat(LIMITS.maxBundleBytes), [
      ...files(LIMITS.maxSourceFiles - 1, 20_000),
      { path: "src/bot.ts", bytes: LIMITS.maxSourceBytes - 49 * 20_000 },
    ]);
    expect(problems).toEqual([]);
    expect(details).toEqual({
      sourceFiles: 50,
      sourceBytes: 1024 * 1024,
      bundleBytes: 256 * 1024,
      largest: [],
    });
  });

  it("reports every limit that is exceeded", () => {
    const { problems } = measureLimits("x".repeat(LIMITS.maxBundleBytes + 1), [
      ...files(50, 100),
      { path: "src/data.json", bytes: LIMITS.maxSourceBytes },
    ]);
    expect(problems).toEqual([
      { limit: "sourceFiles", actual: 51, max: 50 },
      { limit: "sourceBytes", actual: 5000 + 1024 * 1024, max: 1024 * 1024 },
      { limit: "bundleBytes", actual: 256 * 1024 + 1, max: 256 * 1024 },
    ]);
  });

  it("measures the bundle in UTF-8 bytes", () => {
    // 3 bytes per char: 87382 chars are just over 256 KiB.
    const { problems } = measureLimits("€".repeat(87_382), []);
    expect(problems).toEqual([{ limit: "bundleBytes", actual: 262_146, max: 262_144 }]);
  });

  it("lists the largest source files when the sources are too big", () => {
    const { details } = measureLimits("", [
      { path: "src/b.ts", bytes: 10 },
      { path: "src/big.json", bytes: 2_000_000 },
      { path: "src/a.ts", bytes: 10 },
    ]);
    expect(details.largest).toEqual([
      { path: "src/big.json", bytes: 2_000_000 },
      { path: "src/a.ts", bytes: 10 },
      { path: "src/b.ts", bytes: 10 },
    ]);
  });
});

describe("formatBytes", () => {
  it("picks a readable unit", () => {
    expect([812, 14_540, 262_144, 1_100_000, 1_048_576].map(formatBytes)).toEqual([
      "812 B",
      "14.2 KiB",
      "256 KiB",
      "1.05 MiB",
      "1 MiB",
    ]);
  });
});
