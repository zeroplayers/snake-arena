import { afterEach, describe, expect, it, vi } from "vitest";
import { log, logger } from "./log";
import { METRICS, type MetricsDataset, metricColumns, metricPoint, writeMetric } from "./metrics";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("metricPoint", () => {
  it("lays out name, source, blobs and doubles at fixed positions", () => {
    expect(
      metricPoint("deploy.rejected", { reason: "quota_exceeded", userId: "u1", status: 429 }),
    ).toEqual({
      indexes: ["deploy.rejected"],
      blobs: ["deploy.rejected", "web", "quota_exceeded", "u1"],
      doubles: [1, 429],
    });
    expect(
      metricPoint("life.ended", {
        versionId: "v1",
        deathCause: "wall",
        roomId: "r1",
        score: 12,
        ticks: 300,
        kills: 1,
      }),
    ).toEqual({
      indexes: ["life.ended"],
      blobs: ["life.ended", "arena", "v1", "wall", "r1"],
      doubles: [1, 12, 300, 1],
    });
  });

  it("writes null for missing blobs, 0 for non-finite doubles and cuts long blobs", () => {
    const point = metricPoint("ratelimit.limited", { rule: "x".repeat(1000), route: null });
    expect(point.blobs[2]).toHaveLength(256);
    expect(point.blobs[3]).toBeNull();
    expect(metricPoint("deploy.accepted", { userId: "u", status: Number.NaN }).doubles).toEqual([
      1, 0,
    ]);
  });

  it("names the columns of every event", () => {
    expect(metricColumns("arena.liveness")).toEqual({
      status: "blob3",
      minutesSinceActivity: "double2",
      readyVersions: "double3",
      thresholdMinutes: "double4",
    });
    for (const [name, schema] of Object.entries(METRICS)) {
      // Analytics Engine: at most 20 blobs and 20 doubles; two of each are taken.
      expect(schema.blobs.length, name).toBeLessThanOrEqual(18);
      expect(schema.doubles.length, name).toBeLessThanOrEqual(19);
      expect(new Set([...schema.blobs, ...schema.doubles]).size, name).toBe(
        schema.blobs.length + schema.doubles.length,
      );
    }
  });
});

describe("writeMetric", () => {
  it("skips a missing dataset and swallows write errors", () => {
    expect(() =>
      writeMetric(undefined, "deploy.accepted", { userId: "u", status: 201 }),
    ).not.toThrow();
    const failing: MetricsDataset = {
      writeDataPoint: () => {
        throw new Error("boom");
      },
    };
    expect(() =>
      writeMetric(failing, "deploy.accepted", { userId: "u", status: 201 }),
    ).not.toThrow();
  });

  it("writes the point", () => {
    const points: unknown[] = [];
    writeMetric({ writeDataPoint: (p) => points.push(p) }, "auth.failure", {
      kind: "cli_token",
      route: "/api/me",
      status: 401,
    });
    expect(points).toEqual([
      {
        indexes: ["auth.failure"],
        blobs: ["auth.failure", "web", "cli_token", "/api/me"],
        doubles: [1, 401],
      },
    ]);
  });
});

describe("log", () => {
  it("writes one object per call, errors as plain objects, by level", () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    log("info", "api.request", { route: "/api/me", userId: undefined });
    expect(info).toHaveBeenCalledWith({ level: "info", event: "api.request", route: "/api/me" });

    const requestLog = logger({ requestId: "r1" });
    requestLog.error("api.error", { error: new Error("boom", { cause: new TypeError("deep") }) });
    const record = error.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(record).toMatchObject({
      level: "error",
      event: "api.error",
      requestId: "r1",
      error: { name: "Error", message: "boom", cause: { name: "TypeError", message: "deep" } },
    });
    // Serializable as one JSON line.
    expect(JSON.parse(JSON.stringify(record))).toMatchObject({ requestId: "r1" });
  });
});
