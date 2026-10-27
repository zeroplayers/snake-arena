import { describe, expect, it } from "vitest";
import { SLOW_SUITE_MS, slowSuiteWarning } from "./artifact.ts";

describe("slowSuiteWarning", () => {
  it("stays quiet for a suite that ran in the usual few seconds", () => {
    expect(slowSuiteWarning(4_000)).toBeNull();
    expect(slowSuiteWarning(SLOW_SUITE_MS - 1)).toBeNull();
  });

  it("warns that the server's CPU limit, not the 60 s clock, decides", () => {
    const warning = slowSuiteWarning(37_400);
    expect(warning).toContain("The checks took 37 s here");
    expect(warning).toContain("CPU time limit instead of the 60 s clock");
    expect(warning).toContain("the version is rejected");
  });
});
