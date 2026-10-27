import { describe, expect, it } from "vitest";
import { banReport } from "../db.ts";
import type { BanRecord } from "../protocol.ts";
import {
  type CrashMarker,
  INCIDENT_WINDOW_MS,
  judgeCrash,
  judgeTrialCrash,
  retryDelayMs,
  TRIAL_MAX_ATTEMPTS,
  type Trial,
  WATCH_TICKS,
  watching,
  watchWindow,
} from "./backstop.ts";

const LIMIT = 30_000;
const normal = (startedAt: number): CrashMarker => ({
  startedAt,
  watch: false,
  suspectLife: null,
  suspectAt: null,
});
const watched = (startedAt: number, suspectAt: number, suspectLife = "bot"): CrashMarker => ({
  startedAt,
  watch: true,
  suspectLife,
  suspectAt,
});

describe("judgeCrash", () => {
  it("calls anything quicker than the CPU limit a restart", () => {
    expect(judgeCrash(normal(0), 5_000, LIMIT).kind).toBe("restart");
    expect(judgeCrash(normal(0), 0.89 * LIMIT, LIMIT).kind).toBe("restart");
    // The review's case: restarted 120 ms into watch mode while an honest bot ran.
    expect(judgeCrash(watched(0, 100, "honest"), 220, LIMIT).kind).toBe("restart");
  });

  it("blames nobody for a long normal batch", () => {
    expect(judgeCrash(normal(0), 31_000, LIMIT)).toEqual({ kind: "overrun", gapMs: 31_000 });
  });

  it("suspects a watched bot only if its own call must have used the CPU", () => {
    // 2 s of other work, then 29 s inside this bot's call.
    expect(judgeCrash(watched(0, 2_000), 31_000, LIMIT)).toMatchObject({
      kind: "suspect",
      lifeId: "bot",
      callMs: 29_000,
    });
    // Killed 1 s into its call after 29 s of others: not the call's fault alone.
    expect(judgeCrash(watched(0, 29_000), 30_500, LIMIT).kind).toBe("overrun");
    // Between bots (engine step, persistence): nobody.
    expect(judgeCrash({ ...watched(0, 2_000), suspectLife: null }, 31_000, LIMIT).kind).toBe(
      "overrun",
    );
  });
});

describe("judgeTrialCrash", () => {
  const trial = (): Trial => ({
    kind: "cpu",
    lifeId: "bot",
    untilTick: 120,
    maxPendingSeq: 0,
    deaths: [],
    attempts: 0,
    reason: "",
  });
  const died = (t: Trial, tick: number, gap: number) =>
    judgeTrialCrash(t, { ...watched(0, 0), trialTick: tick }, gap, LIMIT);

  it("confirms only after three deaths in a row at the same tick", () => {
    const t = trial();
    expect(died(t, 120, 31_000)).toBe("retry");
    expect(died(t, 120, 31_000)).toBe("retry");
    expect(died(t, 120, 31_000)).toBe("confirmed");
  });

  it("doesn't count restarts, and needs the deaths to match", () => {
    const t = trial();
    expect(died(t, 120, 31_000)).toBe("retry");
    expect(died(t, 120, 2_000)).toBe("retry"); // a restart: not a death
    expect(died(t, 121, 31_000)).toBe("retry"); // a different tick: restarts land anywhere
    expect(died(t, 120, 31_000)).toBe("retry");
    expect(t.deaths).toEqual([120, 121, 120]);
  });

  it("gives up after too many attempts", () => {
    const t = trial();
    let verdict = "retry";
    for (let i = 0; i < TRIAL_MAX_ATTEMPTS; i++) verdict = died(t, i, 31_000);
    expect(verdict).toBe("inconclusive");
  });
});

describe("watchWindow", () => {
  const none = { untilTick: 0, untilMs: 0 };

  it("grows with repeated incidents and never shrinks", () => {
    const first = watchWindow(none, 1, 100, 0, 6000);
    expect(first).toEqual({ untilTick: 100 + WATCH_TICKS, untilMs: 0 });
    const second = watchWindow(first, 2, 200, 0, 6000);
    expect(second).toEqual({ untilTick: 6200, untilMs: 0 });
    const third = watchWindow(second, 3, 300, 5, 6000);
    expect(third).toEqual({ untilTick: 6300, untilMs: 5 + INCIDENT_WINDOW_MS });
    expect(watchWindow(third, 1, 0, 0, 6000)).toEqual(third);
  });

  it("is on while either bound is ahead", () => {
    expect(watching({ untilTick: 10, untilMs: 0 }, 9, 0)).toBe(true);
    expect(watching({ untilTick: 10, untilMs: 0 }, 10, 0)).toBe(false);
    expect(watching({ untilTick: 0, untilMs: 100 }, 50, 99)).toBe(true);
  });
});

it("backs off outbox retries exponentially up to 10 minutes", () => {
  expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([1000, 2000, 4000, 8000]);
  expect(retryDelayMs(50)).toBe(600_000);
});

it("writes a ban as a failed check in the version's CheckReport", () => {
  const ban = { message: "too slow" } as BanRecord;
  const before = { ok: true, checks: [{ name: "loads", ok: true }], qualificationScore: 12 };
  expect(banReport(before, ban)).toEqual({
    ok: false,
    checks: [
      { name: "loads", ok: true },
      { name: "arena-backstop", ok: false, message: "too slow" },
    ],
    qualificationScore: 12,
  });
  expect(banReport(banReport(before, ban), ban).checks).toHaveLength(2);
  expect(banReport(null, ban)).toEqual({
    ok: false,
    checks: [{ name: "arena-backstop", ok: false, message: "too slow" }],
  });
});
