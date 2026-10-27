import { describe, expect, it } from "vitest";
import { lifeRow } from "../db.ts";
import type { LifeResult } from "../protocol.ts";
import {
  ageKills,
  type BotCall,
  type CrashMarker,
  INCIDENT_WINDOW_MS,
  judgeCrash,
  KILL_WINDOW_TICKS,
  KILLS_TO_EVICT,
  type NamedKill,
  nextKills,
  ROOM_KILLS_TO_EVICT,
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

describe("nextKills", () => {
  const suspect = (lifeId: string): Verdict => ({
    kind: "suspect",
    call: call(0, lifeId),
    gapMs: LIMIT,
    callMs: LIMIT,
  });
  const overrun: Verdict = { kind: "overrun", gapMs: LIMIT };
  /** Kills as `[verdict, watched, frame tick]`; every eviction, in order, with its kill (1-based). */
  const run = (verdicts: [Verdict, boolean, number?][]) => {
    let kills: NamedKill[] = [];
    const evicted: [string, number][] = [];
    verdicts.forEach(([verdict, watchedKill, tick = 0], i) => {
      const next = nextKills(kills, verdict, watchedKill, tick);
      kills = next.kills;
      for (const id of next.evict) evicted.push([id, i + 1]);
    });
    return { kills, evicted };
  };
  const named = (ids: string) => [...ids].map((id) => [suspect(id), true] as [Verdict, boolean]);

  it(`evicts a life named ${KILLS_TO_EVICT} times in the window`, () => {
    expect(run(named("aa")).evicted).toEqual([]);
    expect(run(named("aaa")).evicted).toEqual([["a", 3]]);
  });

  it("can't be put off by colluders taking turns (they used to reset each other's streak)", () => {
    // Two versions burning on their own tick parity: the kills alternate.
    expect(run(named("ababab")).evicted).toEqual([
      ["a", 5],
      ["b", 6],
    ]);
    // However many take turns, the room loses at most ROOM_KILLS_TO_EVICT kills.
    expect(ROOM_KILLS_TO_EVICT).toBe(6);
    expect(run(named("abcdef")).evicted).toEqual(
      [..."abcdef"].map((id) => [id, ROOM_KILLS_TO_EVICT]),
    );
    expect(run(named("abcabc")).evicted).toEqual([
      ["a", 6],
      ["b", 6],
      ["c", 6],
    ]);
    // The kill that reaches both counts evicts everyone named.
    expect(run(named("abcbaa")).evicted).toEqual([
      ["a", 6],
      ["b", 6],
      ["c", 6],
    ]);
    // An evicted life's kills still count toward the room's cap.
    expect(run(named("aabacb")).evicted).toEqual([
      ["a", 4],
      ["b", 6],
      ["c", 6],
    ]);
  });

  it("empties on a watched kill that names nobody (only a restart lands between calls)", () => {
    const kills: [Verdict, boolean][] = [...named("aa"), [overrun, true], ...named("aab")];
    expect(run(kills)).toEqual({
      kills: [
        { lifeId: "a", tick: 0 },
        { lifeId: "a", tick: 0 },
        { lifeId: "b", tick: 0 },
      ],
      evicted: [],
    });
  });

  it("ignores restarts and unwatched kills (they can't name anyone)", () => {
    const restart: Verdict = { kind: "restart", gapMs: 100 };
    expect(run([...named("a"), [restart, true], [overrun, false], ...named("aa")]).evicted).toEqual(
      [["a", 5]],
    );
  });

  it(`forgets kills ${KILL_WINDOW_TICKS} ticks of progress back`, () => {
    // Rare kills far apart in a long life don't add up.
    const late = KILL_WINDOW_TICKS - 1;
    expect(
      run([
        [suspect("a"), true, 0],
        [suspect("a"), true, 1],
        [suspect("a"), true, KILL_WINDOW_TICKS + 1],
      ]).evicted,
    ).toEqual([]);
    expect(
      run([
        [suspect("a"), true, 0],
        [suspect("a"), true, 1],
        [suspect("a"), true, late],
      ]).evicted,
    ).toEqual([["a", 3]]);
    // Committed batches age it too.
    const kills = [
      { lifeId: "a", tick: 0 },
      { lifeId: "b", tick: 100 },
    ];
    expect(ageKills(kills, late)).toEqual(kills);
    expect(ageKills(kills, KILL_WINDOW_TICKS + 50)).toEqual([{ lifeId: "b", tick: 100 }]);
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

it("keeps evicted lives out of the lives table", () => {
  const life = { lifeId: "l", versionId: "v", deathCause: "evicted" } as LifeResult;
  expect(lifeRow(life)).toBeNull();
  expect(lifeRow({ ...life, deathCause: "wall" })).toMatchObject({ id: "l", death_cause: "wall" });
});
