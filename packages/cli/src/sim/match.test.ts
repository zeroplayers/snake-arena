import { houseBots } from "@zerosnake/house-bots";
import { afterAll, describe, expect, it } from "vitest";
import { bundleBot } from "../bundle.ts";
import {
  cleanUp,
  GOOD_BOT,
  makeProject,
  SLOW_BOT,
  THROWING_BOT,
  TUNING,
} from "../testing/project.ts";
import { type Contestant, type MatchResult, runMatch } from "./match.ts";
import type { SimChunk } from "./protocol.ts";
import { formatSummary } from "./summary.ts";

afterAll(cleanUp);

async function bundle(source: string, extra: Record<string, string> = {}): Promise<string> {
  const dir = makeProject({ "src/bot.ts": source, ...extra });
  return (await bundleBot("src/bot.ts", { cwd: dir })).code;
}

function lineup(you: string): Contestant[] {
  return [
    { name: "mine", bundle: you, you: true },
    { name: "easy", bot: houseBots.easy },
    { name: "hard", bot: houseBots.hard },
  ];
}

describe("runMatch", () => {
  it("runs the bot in the sandbox against house bots, recording every tick", async () => {
    const you = await bundle(GOOD_BOT, { "src/tuning.ts": TUNING });
    const chunks: SimChunk[] = [];
    const result = await runMatch({
      contestants: lineup(you),
      seed: 4,
      ticks: 250,
      chunkTicks: 100,
      onChunk: (c) => chunks.push(c),
    });

    expect(result.ticks).toBe(250);
    expect(chunks.map((c) => c.calls.length)).toEqual([100, 100, 50]);
    const mine = result.bots.find((b) => b.name === "mine");
    expect(mine?.you).toBe(true);
    expect(mine?.calls).toBeGreaterThan(0);
    expect(mine?.maxOps).toBeLessThanOrEqual(result.opBudget);

    // Sandbox calls carry ops; house bots run natively and don't.
    const first = chunks[0]?.calls[0];
    expect(first?.["mine#1"]?.o).toBeTypeOf("number");
    expect(first?.["easy#1"]?.o).toBeUndefined();
    const logged = chunks.flatMap((c) => c.calls).flatMap((t) => t["mine#1"]?.l ?? []);
    expect(logged).toContain("tick 50");
  });

  it("is deterministic for a seed", async () => {
    const you = await bundle(GOOD_BOT, { "src/tuning.ts": TUNING });
    const strip = (r: MatchResult) => JSON.stringify(r);
    const a = await runMatch({ contestants: lineup(you), seed: 9, ticks: 300 });
    const b = await runMatch({ contestants: lineup(you), seed: 9, ticks: 300 });
    expect(strip(a)).toBe(strip(b));
  });

  it("kills a bot that keeps going over its op budget, and says why", async () => {
    const result = await runMatch({
      contestants: lineup(await bundle(SLOW_BOT)),
      seed: 1,
      ticks: 40,
    });
    const life = result.lives.find((l) => l.id === "mine#1");

    expect(life?.death?.cause).toBe("timeout");
    expect(life?.death?.sandbox?.reason).toBe("timeouts");
    expect(life?.death?.tick).toBe(3);
    expect(result.bots[0]?.overBudget).toBeGreaterThanOrEqual(3);
    const summary = formatSummary(result);
    expect(summary).toContain("mine#1: ticks 0–3");
    expect(summary).toContain("too slow: 3 ticks in a row over budget");
    expect(summary).toContain("calls over budget; first at tick 0 (mine#1)");
    // One hint for the kind of death, not one per life.
    expect(summary.split("A tick may use 10 ops").length).toBe(2);
  });

  it("kills a bot that throws 3 ticks in a row, with the error", async () => {
    const result = await runMatch({
      contestants: lineup(await bundle(THROWING_BOT)),
      seed: 1,
      ticks: 40,
    });
    const life = result.lives.find((l) => l.id === "mine#1");

    expect(life?.death?.cause).toBe("error");
    expect(life?.death?.sandbox?.message).toContain("TypeError");
    expect(formatSummary(result)).toMatch(/kept crashing: 3 ticks in a row threw; last: TypeError/);
    // It comes back as a new life after the respawn delay, and dies again.
    expect(result.lives.filter((l) => l.bot === "mine").length).toBeGreaterThan(1);
  });

  it("marks sandbox verdicts in the bot's log for the viewer", async () => {
    const chunks: SimChunk[] = [];
    await runMatch({
      contestants: lineup(await bundle(SLOW_BOT)),
      seed: 1,
      ticks: 10,
      onChunk: (c) => chunks.push(c),
    });
    const calls = chunks.flatMap((c) => c.calls);
    expect(calls[0]?.["mine#1"]?.l).toEqual([
      "thinking hard",
      "⚠ over the op budget (11/10), strike 1",
    ]);
    expect(calls[2]?.["mine#1"]?.l?.at(-1)).toMatch(/^⚠ sandbox: too slow/);
  });

  it("stops early on abort", async () => {
    const you = await bundle(GOOD_BOT, { "src/tuning.ts": TUNING });
    const controller = new AbortController();
    const result = await runMatch({
      contestants: lineup(you),
      seed: 2,
      ticks: 10_000,
      chunkTicks: 50,
      yieldBetweenChunks: true,
      signal: controller.signal,
      onChunk: () => controller.abort(),
    });
    expect(result.ticks).toBe(51);
  });
});
