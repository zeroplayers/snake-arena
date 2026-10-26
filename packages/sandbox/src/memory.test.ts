import type { BotState } from "@zerosnake/sdk";
import { describe, expect, it } from "vitest";
import { createSandbox, DEFAULT_WASM_MEMORY_CAP_BYTES, type Sandbox } from "./index.ts";
import { botWithTick, makeInfo, makeStates, oneState } from "./testing/fixtures.ts";

const HONEST = botWithTick("mem.n = (mem.n ?? 0) + 1; return { turn: mem.n / 100 };");

describe("memory", () => {
  it("kills a bot on its first OOM and keeps the sandbox usable", async () => {
    const sandbox = await createSandbox();
    const honest = sandbox.startLife(HONEST, makeInfo());
    // Many medium strings: each allocation is small, so QuickJS's own limit never sees them;
    // only the capped wasm heap stops this.
    const hog = sandbox.startLife(
      botWithTick(
        "for (;;) hoard.push(chunk + Math.random());",
        "const hoard = []; const chunk = 'x'.repeat(1000);",
      ),
      makeInfo(),
    );
    const states = makeStates(5);
    let report = hog.tick(oneState());
    for (const state of states) if (!report.death) report = hog.tick(state);
    expect(report.death).toMatchObject({ fault: "error", reason: "oom" });
    expect(report.death?.message).toMatch(/^out of memory/);
    expect(sandbox.heapBytes).toBeLessThanOrEqual(DEFAULT_WASM_MEMORY_CAP_BYTES);

    // The heap is at its cap, but the hog's memory was freed with its runtime.
    for (const state of states) expect(honest.tick(state).outcome).toBe("ok");
    const next = sandbox.startLife(HONEST, makeInfo());
    expect(next.death).toBeNull();
    expect(next.tick(oneState()).action).toEqual({ turn: 0.01 });
    honest.dispose();
    next.dispose();
  });

  // Review of #49: a hog that catches its OOM used to survive and keep the heap.
  const CATCHING_HOG = botWithTick(
    "try { for (;;) hoard.push(chunk + Math.random()); } catch { hoard.length -= 40; } return { turn: 0.5 };",
    "const hoard = []; const chunk = 'y'.repeat(4096);",
  );

  /** Fills the heap to its cap with a throwaway bot, so later allocations can't grow it. */
  function growHeapToCap(sandbox: Sandbox): void {
    const filler = sandbox.startLife(
      botWithTick(
        "for (;;) hoard.push(chunk + Math.random());",
        "const hoard = []; const chunk = 'x'.repeat(4096);",
      ),
      makeInfo({ opBudget: 1000 }),
    );
    filler.tick(oneState());
    filler.dispose();
    expect(sandbox.heapBytes).toBeGreaterThan(DEFAULT_WASM_MEMORY_CAP_BYTES - 8 * 1024 * 1024);
  }

  it("kills a bot that catches its OOM, as soon as it grows the heap", async () => {
    const sandbox = await createSandbox();
    const hog = sandbox.startLife(CATCHING_HOG, makeInfo());
    const report = hog.tick(oneState());
    expect(report.outcome).not.toBe("ok");
    expect(report.death).toMatchObject({ fault: "error", reason: "oom" });
  });

  it("kills a bot that catches its OOM in a heap that can't grow any more", async () => {
    const sandbox = await createSandbox();
    growHeapToCap(sandbox);
    const honest = sandbox.startLife(HONEST, makeInfo());
    const hog = sandbox.startLife(CATCHING_HOG, makeInfo({ opBudget: 1000 }));
    const report = hog.tick(oneState());
    expect(report.death).toMatchObject({ fault: "error", reason: "oom" });
    expect(honest.tick(oneState())).toMatchObject({ outcome: "ok", action: { turn: 0.01 } });
  });

  it("blames the bot over its limit, not the bot that hit the full heap", async () => {
    const sandbox = await createSandbox();
    growHeapToCap(sandbox);
    // Takes ~52 MB without growing the heap (it is already at its cap) and without failing, so
    // nothing notices until the next periodic check.
    const hog = sandbox.startLife(
      botWithTick(
        "if (hoard.length === 0) for (let i = 0; i < 13000; i++) hoard.push(chunk + i); return { turn: 0.5 };",
        "const hoard = []; const chunk = 'h'.repeat(4096);",
      ),
      makeInfo({ opBudget: 1000 }),
      { memoryCheckInterval: 1000 },
    );
    expect(hog.tick(oneState())).toMatchObject({ outcome: "ok", death: null });
    // Within its own (raised) limit, but the heap has no room left for it.
    const victim = sandbox.startLife(
      botWithTick(
        "if (state.lifeTick === 0) return { turn: 0.25 }; for (let i = 0; i < 3500; i++) mem.k.push(chunk + i); return { turn: 1 };",
        "const chunk = 'v'.repeat(4096);",
      ).replace("tick(state, mem, log) {", "init() { return { k: [] }; }, tick(state, mem, log) {"),
      makeInfo({ opBudget: 1000 }),
      { memoryLimitBytes: 32 * 1024 * 1024 },
    );
    const states = makeStates(2);
    expect(victim.tick(states[0] as BotState).action).toEqual({ turn: 0.25 });
    const report = victim.tick(states[1] as BotState);
    expect(report).toMatchObject({
      outcome: "skipped",
      action: { turn: 0.25 },
      strikes: 0,
      errors: 0,
      death: null,
    });
    expect(hog.death).toMatchObject({ fault: "error", reason: "oom" });
    expect(hog.tick(oneState()).death).toBe(hog.death);
  });

  it("kills a slow leaker at the periodic memory check", async () => {
    const sandbox = await createSandbox();
    const life = sandbox.startLife(
      botWithTick(
        "mem.k ??= []; for (let i = 0; i < 300; i++) mem.k.push('y'.repeat(100) + i); return { turn: 0 };",
      ),
      makeInfo(),
      { memoryLimitBytes: 1024 * 1024, memoryCheckInterval: 5 },
    );
    const reports = makeStates(40).map((s) => life.tick(s));
    const deathAt = reports.findIndex((r) => r.death);
    // ~40 KB per tick: over 1 MB around tick 25, caught at the next multiple of 5.
    expect(deathAt % 5).toBe(4);
    expect(deathAt).toBeGreaterThan(15);
    expect(reports[deathAt]?.death).toMatchObject({ fault: "error", reason: "oom" });
    expect(reports[deathAt]?.death?.message).toMatch(
      /^out of memory: \d+ bytes in use, limit 1048576$/,
    );
    expect(reports[deathAt]?.outcome).toBe("ok"); // the tick itself ran; its action still counts
  });

  it("reports an honest bot's memory well under the limit", async () => {
    const sandbox = await createSandbox();
    const life = sandbox.startLife(HONEST, makeInfo());
    expect(life.memoryUsed()).toBeGreaterThan(10_000);
    expect(life.memoryUsed()).toBeLessThan(1024 * 1024);
    life.dispose();
    expect(life.memoryUsed()).toBe(0);
  });

  it("stops deep recursion with a catchable stack overflow", async () => {
    const sandbox = await createSandbox();
    const life = sandbox.startLife(botWithTick("const f = (n) => f(n + 1) + 1; f(0);"), makeInfo());
    const report = life.tick(oneState());
    expect(report.outcome).toBe("error");
    expect(report.error).toMatch(/stack overflow/);
    expect(report.death).toBeNull();
    life.dispose();
  });

  it("rejects a cap below the QuickJS heap minimum", async () => {
    await expect(createSandbox({ wasmMemoryCapBytes: 1024 * 1024 })).rejects.toThrow(RangeError);
  });
});
