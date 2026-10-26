import { describe, expect, it } from "vitest";
import { createSandbox, DEFAULT_WASM_MEMORY_CAP_BYTES } from "./index.ts";
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
    expect(report.death?.message).toMatch(/^InternalError: out of memory/);
    expect(sandbox.heapBytes).toBeLessThanOrEqual(DEFAULT_WASM_MEMORY_CAP_BYTES);

    // The heap is at its cap, but the hog's memory was freed with its runtime.
    for (const state of states) expect(honest.tick(state).outcome).toBe("ok");
    const next = sandbox.startLife(HONEST, makeInfo());
    expect(next.death).toBeNull();
    expect(next.tick(oneState()).action).toEqual({ turn: 0.01 });
    honest.dispose();
    next.dispose();
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
