import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OwnTrace } from "../queries/trace";
import type { TraceTick } from "../shared/trace";
import { TracePanel } from "./TracePanel";

const tick = (lifeTick: number, extra: Partial<TraceTick> = {}): TraceTick => ({
  tick: 1000 + lifeTick,
  lifeTick,
  turn: 0.2,
  boost: false,
  outcome: "ok",
  work: 500_000,
  ops: 1,
  log: [`tick ${lifeTick}`],
  seen: {
    x: 0,
    y: 0,
    angle: 0,
    length: 10,
    wall: 30,
    snakes: 1,
    food: 2,
    nearest: { id: "x", author: "eve", gap: 0.3, length: 40, head: true },
    foodDist: 4,
  },
  ...extra,
});

const trace: OwnTrace = {
  format: 1,
  lifeId: "life-1",
  versionId: "v1",
  roomId: "r",
  startTick: 1000,
  endTick: 1030,
  cause: "collision",
  killer: "v-eve",
  killerName: "@eve/viper v2",
  budget: { ops: 10, work: 10_000_000, logBytes: 1024 },
  totals: {
    ticks: 30,
    timeouts: 0,
    errors: 1,
    skipped: 0,
    maxWork: 5_000_000,
    sumWork: 15_000_000,
    maxOps: 3,
    logTicks: 30,
    logBytes: 200,
  },
  load: { log: [] },
  restarts: [],
  sampleEvery: 1,
  sampled: [tick(0)],
  events: [],
  full: Array.from({ length: 29 }, (_, i) =>
    tick(i + 1, i === 28 ? { outcome: "error", error: "boom" } : {}),
  ),
};

describe("TracePanel", () => {
  it("shows the owner the last ticks: what it saw, returned, spent and logged", () => {
    const html = renderToString(<TracePanel trace={{ status: "ok", trace }} />);
    expect(html).toContain("Death context");
    expect(html).toContain("@eve/viper v2");
    expect(html).toContain("50%"); // peak cost
    expect(html).toContain("tick 29");
    expect(html).toContain("error<!-- -->: boom");
    expect(html).toContain("@<!-- -->eve<!-- --> at <!-- -->0.3");
    // The last 20 by default.
    expect(html).not.toContain("tick 9<");
    expect(html).toContain("tick 10");
    expect(html).toContain("Show all");
  });

  it("explains why others don't see it", () => {
    const html = renderToString(<TracePanel trace={{ status: "private", signedIn: false }} />);
    expect(html).toContain("sign in if that&#x27;s you");
    expect(html).not.toContain("<table");
    expect(renderToString(<TracePanel trace={{ status: "expired" }} />)).toContain(
      "kept <!-- -->7<!-- --> days",
    );
  });
});
