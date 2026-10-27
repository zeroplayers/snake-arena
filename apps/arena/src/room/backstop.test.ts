import { describe, expect, it } from "vitest";
import { lifeRow, quarantineReport } from "../db.ts";
import type { LifeResult, QuarantineRecord } from "../protocol.ts";
import {
  type BotCall,
  type CrashMarker,
  INCIDENT_WINDOW_MS,
  judgeCrash,
  KILLS_TO_EVICT,
  type KillStreak,
  nextStreak,
  retryDelayMs,
  type Verdict,
  WATCH_TICKS,
  watchGapMs,
  watching,
  watchWindow,
} from "./backstop.ts";

const LIMIT = 30_000;
const normal = (startedAt: number): CrashMarker => ({ startedAt, watch: false, call: null });
const call = (at: number, lifeId = "bot", before = at): BotCall => ({
  lifeId,
  kind: "tick",
  tick: 7,
  at,
  before,
});
const watched = (startedAt: number, at: number | null, lifeId = "bot"): CrashMarker => ({
  startedAt,
  watch: true,
  call: at === null ? null : call(at, lifeId),
});

describe("judgeCrash", () => {
  it("calls anything quicker than the CPU limit a restart", () => {
    expect(judgeCrash(normal(0), 5_000, LIMIT).kind).toBe("restart");
    expect(judgeCrash(normal(0), 0.89 * LIMIT, LIMIT).kind).toBe("restart");
    // Restarted 120 ms into watch mode while an honest bot ran.
    expect(judgeCrash(watched(0, 100, "honest"), 220, LIMIT).kind).toBe("restart");
  });

  it("names nobody for a long normal batch", () => {
    expect(judgeCrash(normal(0), 31_000, LIMIT)).toEqual({ kind: "overrun", gapMs: 31_000 });
  });

  it("names a watched call only if it ran long enough to have used the CPU", () => {
    // 2 s of other work, then 29 s inside this bot's call.
    expect(judgeCrash(watched(0, 2_000), 31_000, LIMIT)).toMatchObject({
      kind: "suspect",
      call: { lifeId: "bot" },
      callMs: 29_000,
    });
    // Killed 1 s into its call after 29 s of others: not the call alone.
    expect(judgeCrash(watched(0, 29_000), 30_500, LIMIT).kind).toBe("overrun");
    // 29 s after the start, but 28 s of that were random waits: 1 s of CPU at most before it.
    expect(
      judgeCrash({ ...watched(0, 0), call: call(29_000, "bot", 1_000) }, 58_500, LIMIT),
    ).toMatchObject({
      kind: "suspect",
    });
    // Between calls (engine step, persistence, the random wait): nobody.
    expect(judgeCrash(watched(0, null), 31_000, LIMIT).kind).toBe("overrun");
  });
});

describe("nextStreak", () => {
  const suspect = (lifeId: string): Verdict => ({
    kind: "suspect",
    call: call(0, lifeId),
    gapMs: LIMIT,
    callMs: LIMIT,
  });
  const run = (verdicts: [Verdict, boolean][]) => {
    let streak: KillStreak | null = null;
    const evicted: string[] = [];
    for (const [verdict, watchedKill] of verdicts) {
      const next = nextStreak(streak, verdict, watchedKill);
      streak = next.streak;
      if (next.evict) evicted.push(next.evict);
    }
    return { streak, evicted };
  };

  it(`evicts after ${KILLS_TO_EVICT} watched kills in a row in one life's calls`, () => {
    const kills = Array.from({ length: KILLS_TO_EVICT }, () => [suspect("a"), true] as const);
    expect(run(kills.slice(0, -1) as [Verdict, boolean][])).toEqual({
      streak: { lifeId: "a", kills: KILLS_TO_EVICT - 1 },
      evicted: [],
    });
    expect(run(kills as [Verdict, boolean][])).toEqual({ streak: null, evicted: ["a"] });
  });

  it("starts over when a kill names another life or nobody in watch mode", () => {
    const overrun: Verdict = { kind: "overrun", gapMs: LIMIT };
    expect(
      run([
        [suspect("a"), true],
        [suspect("a"), true],
        [suspect("b"), true],
        [suspect("a"), true],
        [overrun, true], // between calls: a real overrun never gets there
        [suspect("a"), true],
        [suspect("a"), true],
      ]).evicted,
    ).toEqual([]);
  });

  it("ignores restarts and unwatched kills (they can't name anyone)", () => {
    const restart: Verdict = { kind: "restart", gapMs: 100 };
    const overrun: Verdict = { kind: "overrun", gapMs: LIMIT };
    expect(
      run([
        [suspect("a"), true],
        [restart, true],
        [overrun, false],
        [suspect("a"), true],
        [suspect("a"), true],
      ]).evicted,
    ).toEqual(["a"]);
  });
});

it("waits a random while after a watched call, longer after longer calls, capped", () => {
  expect(watchGapMs(5, 10, 0, LIMIT)).toBe(0);
  expect(watchGapMs(5, 10, 1, LIMIT)).toBe(110);
  expect(watchGapMs(-1, 10, 0.5, LIMIT)).toBe(5);
  expect(watchGapMs(5, 10, 1, 400)).toBe(100);
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

it("notes a quarantine as a failed check, keeping the report's checks and verdict", () => {
  const q = { message: "under review" } as QuarantineRecord;
  const before = { ok: true, checks: [{ name: "loads", ok: true }], qualificationScore: 12 };
  expect(quarantineReport(before, q)).toEqual({
    ok: true,
    checks: [
      { name: "loads", ok: true },
      { name: "arena-backstop", ok: false, message: "under review" },
    ],
    qualificationScore: 12,
  });
  expect(quarantineReport(quarantineReport(before, q), q).checks).toHaveLength(2);
  expect(quarantineReport(null, q)).toEqual({
    ok: true,
    checks: [{ name: "arena-backstop", ok: false, message: "under review" }],
  });
});

it("keeps evicted lives out of the lives table", () => {
  const life = { lifeId: "l", versionId: "v", deathCause: "evicted" } as LifeResult;
  expect(lifeRow(life)).toBeNull();
  expect(lifeRow({ ...life, deathCause: "wall" })).toMatchObject({ id: "l", death_cause: "wall" });
});
