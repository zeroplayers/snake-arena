import { DEFAULT_CONFIG } from "@zerosnake/engine";
import { houseBots } from "@zerosnake/house-bots";
import { foodDisplaySize } from "@zerosnake/viewer/food";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleBot } from "../bundle.ts";
import { cleanUp, makeProject, SLOW_BOT } from "../testing/project.ts";
import { type MatchResult, runMatch } from "./match.ts";
import type { SimChunk } from "./protocol.ts";
import { RecordedMatchSource } from "./source.ts";

afterAll(cleanUp);

let result: MatchResult;
const chunks: SimChunk[] = [];
const BOTS = ["slow", "easy", "medium"];

beforeAll(async () => {
  const dir = makeProject({ "src/bot.ts": SLOW_BOT });
  const slow = (await bundleBot("src/bot.ts", { cwd: dir })).code;
  result = await runMatch({
    contestants: [
      { name: "slow", bundle: slow, you: true },
      { name: "easy", bot: houseBots.easy },
      { name: "medium", bot: houseBots.medium },
    ],
    seed: 11,
    ticks: 120,
    chunkTicks: 50,
    respawnDelay: 5,
    onChunk: (c) => chunks.push(c),
  });
});

function fullSource(): RecordedMatchSource {
  const source = new RecordedMatchSource(result.info, BOTS);
  source.append(chunks, result.lives);
  source.finish();
  return source;
}

describe("RecordedMatchSource", () => {
  it("covers the recorded ticks and ends when finished", () => {
    const source = new RecordedMatchSource(result.info, BOTS);
    expect(source.lastTick).toBe(0);
    expect(source.snapshot(0)).toBeUndefined();
    source.append(chunks, result.lives);
    expect([source.firstTick, source.lastTick, source.endTick]).toEqual([0, 120, undefined]);
    source.finish();
    expect(source.endTick).toBe(120);
  });

  it("shows every snake with its bot's call on that tick", () => {
    const source = fullSource();
    const snap = source.snapshot(0);
    expect(snap?.snakes.map((s) => s.id)).toEqual(["slow#1", "easy#1", "medium#1"]);
    expect(snap?.frame.snakes).toHaveLength(3);
    expect(snap?.frame.food.length).toBeGreaterThan(0);
    const slow = snap?.snakes[0];
    expect(slow?.ops).toBe(11);
    expect(slow?.logs).toEqual(["thinking hard", "⚠ over the op budget (11/10), strike 1"]);
    expect(snap?.snakes[1]?.ops).toBeUndefined();
    expect(source.trace("slow#1", 0)).toEqual({
      action: { turn: 0, boost: false },
      logs: slow?.logs,
      logTruncated: false,
      ops: 11,
    });
  });

  it("reports a death on the tick the snake is gone", () => {
    const source = fullSource();
    const life = source.life("slow#1");
    expect(life?.death?.cause).toBe("timeout");
    expect(life?.color).toMatch(/^#[0-9a-f]{6}$/i);
    const tick = life?.death?.tick as number;
    expect(source.snapshot(tick - 1)?.snakes.some((s) => s.id === "slow#1")).toBe(true);
    expect(source.snapshot(tick)?.snakes.some((s) => s.id === "slow#1")).toBe(false);
    expect(source.snapshot(tick)?.deaths).toContain("slow#1");
  });

  it("draws remains with the viewer's display size, not their gameplay radius", () => {
    const source = fullSource();
    const tick = source.life("slow#1")?.death?.tick as number;
    const sizes = (source.snapshot(tick)?.frame.food ?? []).map((f) => f.size);
    const ambient = foodDisplaySize("ambient", DEFAULT_CONFIG);
    const remains = foodDisplaySize("remains", DEFAULT_CONFIG);
    expect(sizes).toContain(remains);
    expect(sizes.every((s) => s === ambient || s === remains)).toBe(true);
  });

  it("seeks backwards and forwards to the same frames", () => {
    const source = fullSource();
    const forward = [10, 60, 119].map((t) => JSON.stringify(source.snapshot(t)));
    const again = fullSource();
    const backward = [119, 60, 10].map((t) => JSON.stringify(again.snapshot(t))).reverse();
    expect(backward).toEqual(forward);
  });

  it("grows as chunks stream in, hiding lives not born yet", () => {
    const streamed = new RecordedMatchSource(result.info, BOTS);
    const livesSoFar = result.lives; // The match knows lives past the chunks sent so far.
    streamed.append(chunks.slice(0, 1), livesSoFar);
    expect(streamed.lastTick).toBe(50);
    expect(streamed.lives().every((l) => l.bornTick <= 50)).toBe(true);
    streamed.append(chunks.slice(1), livesSoFar);
    expect(streamed.lastTick).toBe(120);
    expect(JSON.stringify(streamed.snapshot(100))).toBe(JSON.stringify(fullSource().snapshot(100)));
  });
});
