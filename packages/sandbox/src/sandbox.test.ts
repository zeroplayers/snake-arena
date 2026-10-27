import { type BotAction, createTickLog } from "@zerosnake/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { createSandbox, type Sandbox, type TickReport } from "./index.ts";
import { UNITS_PER_WEIGHT } from "./instrument.ts";
import exampleBot from "./testing/example-bot.ts";
import {
  botWithTick,
  bundleExampleBot,
  makeInfo,
  makeStates,
  oneState,
} from "./testing/fixtures.ts";

let sandbox: Sandbox;
beforeAll(async () => {
  sandbox = await createSandbox();
});

function run(source: string, ticks: number, info = makeInfo()): TickReport[] {
  const life = sandbox.startLife(source, info);
  const states = makeStates(ticks);
  const reports = states.map((s) => life.tick(s));
  life.dispose();
  return reports;
}

describe("happy path", () => {
  it("runs the SDK example bot exactly like running it natively", async () => {
    const source = await bundleExampleBot();
    const info = makeInfo({ seed: 7 });
    const states = makeStates(40);
    const life = sandbox.startLife(source, info);
    expect(life.death).toBeNull();

    // Native reference: same module, Node's own JS engine. Math.random is the only thing the
    // sandbox replaces, so feed the native run the sandbox's first rolls via the logs.
    const mem = exampleBot.init?.(info);
    if (!mem) throw new Error("init missing");
    const native = createTickLog();
    for (const state of states) {
      const report = life.tick(state);
      expect(report.outcome).toBe("ok");
      expect(report.death).toBeNull();
      const expected: BotAction = exampleBot.tick(state, mem, native.log);
      expect(report.action).toEqual(expected.boost ? expected : { turn: expected.turn });
      const lines = native.flush().lines.map((l) => l.replace(/"roll":[\d.e-]+/, '"roll":R'));
      expect(report.log.lines.map((l) => l.replace(/"roll":[\d.e-]+/, '"roll":R'))).toEqual(lines);
    }
    // The bot fled at least once and logged its rolls, so all branches ran.
    expect(mem.fled).toBeGreaterThan(0);
    life.dispose();
  });

  it("reports interrupts and cost units per tick", () => {
    const [light] = run(botWithTick("return { turn: 0 };"), 1);
    expect(light).toMatchObject({ outcome: "ok", interrupts: 0 });
    // Just the charge for entering tick() and building `{ turn: 0 }`.
    expect(light?.work).toBeGreaterThan(0);
    expect(light?.work).toBeLessThan(50 * UNITS_PER_WEIGHT);
    const [busy] = run(
      botWithTick(
        "let s = 0; for (let i = 0; i < 20000; i++) s += i; [1,2,3].indexOf(2); return { turn: 0 };",
      ),
      1,
    );
    expect(busy?.outcome).toBe("ok");
    expect(busy?.interrupts).toBeGreaterThan(0);
    // Test, update and body are charged once per iteration; indexOf pays for its 3 elements.
    expect(busy?.work).toBeGreaterThan(20000 * 10 * UNITS_PER_WEIGHT);
    expect(busy?.work).toBeLessThan(20000 * 20 * UNITS_PER_WEIGHT);
  });

  it("clamps turn and normalises boost", () => {
    const reports = run(
      botWithTick(
        "const t = [5, -5, NaN, 'x', 0.5][state.lifeTick % 5]; return { turn: t, boost: state.lifeTick === 4 ? 1 : state.lifeTick === 3 };",
      ),
      5,
    );
    expect(reports.map((r) => r.action)).toEqual([
      { turn: 1 },
      { turn: -1 },
      { turn: 0 },
      { turn: 0, boost: true },
      { turn: 0.5 },
    ]);
  });
});

describe("memory and lives", () => {
  it("keeps memory between ticks and resets it between lives", () => {
    const source = `
      let moduleCounter = 0;
      export default {
        init() { return { n: 0 }; },
        tick(state, mem, log) { mem.n++; moduleCounter++; log(mem.n, moduleCounter); return { turn: 0 }; },
      };`;
    const first = run(source, 3).map((r) => r.log.lines[0]);
    const second = run(source, 2).map((r) => r.log.lines[0]);
    expect(first).toEqual(["1 1", "2 2", "3 3"]);
    expect(second).toEqual(["1 1", "2 2"]);
  });

  it("passes info to init and defaults memory to {}", () => {
    const withInit = run(
      `export default { init(info) { return { info }; }, tick(s, mem, log) { log(mem.info.snakeId, mem.info.opBudget, mem.info.seed); return { turn: 0 }; } };`,
      1,
      makeInfo({ seed: 99 }),
    );
    expect(withInit[0]?.log.lines).toEqual(["me 10 99"]);
    const noInit = run(botWithTick("log(JSON.stringify(mem)); return { turn: 0 };"), 1);
    expect(noInit[0]?.log.lines).toEqual(["{}"]);
  });

  it("is dead on arrival when the module is not a bot", () => {
    const cases: [string, RegExp][] = [
      ["export const x = 1;", /export default defineBot/],
      ["export default { init() { return {}; } };", /no tick\(\) function/],
      ["export default { tick() {}, init() { return 5; } };", /init\(\) must return an object/],
      ["export default { tick() {}, init() { throw new Error('nope'); } };", /Error: nope/],
      ["this is not javascript", /SyntaxError/],
      ["await 1; export default { tick() {} };", /top-level await/],
    ];
    for (const [source, message] of cases) {
      const life = sandbox.startLife(source, makeInfo());
      expect(life.death, source).toMatchObject({ fault: "error", reason: "load" });
      expect(life.death?.message).toMatch(message);
      const report = life.tick(oneState());
      expect(report).toMatchObject({ outcome: "error", action: { turn: 0 }, death: life.death });
    }
  });

  it("times out a module or init that never finishes", () => {
    for (const source of [
      "for (;;) {} export default { tick() {} };",
      "export default { init() { for (;;) {} }, tick() {} };",
    ]) {
      const life = sandbox.startLife(source, makeInfo());
      expect(life.death).toMatchObject({ fault: "timeout", reason: "load" });
    }
  });
});

describe("budget", () => {
  it("kills while(true) within a single tick", () => {
    const start = performance.now();
    const [report] = run(botWithTick("while (true) {}"), 1);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(report).toMatchObject({ outcome: "timeout", strikes: 1, death: null });
    expect(report?.interrupts).toBe(11);
  });

  it("cannot be caught by the bot", () => {
    const [report] = run(
      botWithTick("for (;;) { try { for (;;) {} } catch (e) {} finally { continue; } }"),
      1,
    );
    expect(report?.outcome).toBe("timeout");
  });

  it("has no Promise, which could swallow the interrupt (reviews of #49 and #62)", () => {
    for (const body of [
      "for (let j = 0; j < 3000; j++) new Promise(() => { for (let i = 0; i < 1e6; i++); }); return { turn: 0.5 };",
      "for (;;) Promise.resolve().then(() => {}, () => {}); return { turn: 0.5 };",
    ]) {
      const life = sandbox.startLife(botWithTick(body), makeInfo());
      const start = performance.now();
      const report = life.tick(oneState());
      expect(performance.now() - start, body).toBeLessThan(1000);
      expect(report, body).toMatchObject({ outcome: "error", action: { turn: 0 } });
      expect(report.error).toMatch(/^ReferenceError: .*Promise/);
      life.dispose();
    }
  });

  it("rejects async code, which could swallow the interrupt", () => {
    for (const source of [
      "export default { async tick() { return { turn: 0 }; } };",
      "export default { tick() { (async () => {})(); return { turn: 0 }; } };",
      "export default { tick() { const f = async function* () {}; return { turn: 0 }; } };",
    ]) {
      const life = sandbox.startLife(source, makeInfo());
      expect(life.death, source).toMatchObject({ fault: "error", reason: "load" });
      expect(life.death?.message).toMatch(/^async functions are not available to bots/);
    }
    // An escaped spelling is not the keyword: QuickJS reports a syntax error.
    const escaped = sandbox.startLife("export default { \\u0061sync tick() {} };", makeInfo());
    expect(escaped.death?.message).toMatch(/SyntaxError/);
  });

  it("reuses the previous action and dies after 3 timeouts in a row", () => {
    const reports = run(
      botWithTick(`
        if (state.lifeTick === 0) return { turn: 0.25, boost: true };
        if (state.lifeTick === 2) return { turn: -0.5 };
        for (;;) {}`),
      6,
    );
    expect(reports.map((r) => [r.outcome, r.strikes, r.action.turn])).toEqual([
      ["ok", 0, 0.25],
      ["timeout", 1, 0.25],
      ["ok", 0, -0.5],
      ["timeout", 1, -0.5],
      ["timeout", 2, -0.5],
      ["timeout", 3, -0.5],
    ]);
    expect(reports[5]?.death).toEqual({
      fault: "timeout",
      reason: "timeouts",
      message: "3 ticks in a row over budget",
    });
  });

  it("uses info.opBudget as the budget", () => {
    const body = "let s = 0; for (let i = 0; i < 200000; i++) s += i; return { turn: 0 };";
    expect(run(botWithTick(body), 1, makeInfo({ opBudget: 10 }))[0]?.outcome).toBe("timeout");
    const [big] = run(botWithTick(body), 1, makeInfo({ opBudget: 1000 }));
    expect(big?.outcome).toBe("ok");
    expect(big?.interrupts).toBeGreaterThan(10);
  });
});

describe("errors", () => {
  it("reuses the previous action and dies after 3 exceptions in a row", () => {
    const reports = run(
      botWithTick(`
        if (state.lifeTick === 0 || state.lifeTick === 3) return { turn: state.lifeTick / 10 };
        if (state.lifeTick === 2) for (;;) {}
        throw new Error('bad tick ' + state.lifeTick);`),
      7,
    );
    expect(reports.map((r) => [r.outcome, r.errors, r.action.turn])).toEqual([
      ["ok", 0, 0],
      ["error", 1, 0],
      ["timeout", 0, 0], // a timeout breaks the error streak
      ["ok", 0, 0.3],
      ["error", 1, 0.3],
      ["error", 2, 0.3],
      ["error", 3, 0.3],
    ]);
    expect(reports[1]?.error).toMatch(/^Error: bad tick 1\n.*at tick \(bot\.js/);
    expect(reports[6]?.death).toMatchObject({ fault: "error", reason: "errors" });
    expect(reports[6]?.death?.message).toMatch(/3 ticks in a row threw; last: Error: bad tick 6/);
  });

  it("treats a bad return value as an error", () => {
    for (const ret of ["undefined", "null", "1", "'left'"]) {
      const [report] = run(botWithTick(`return ${ret};`), 1);
      expect(report?.outcome).toBe("error");
      expect(report?.error).toMatch(/tick\(\) must return an action/);
    }
  });

  it("caps the message of a huge thrown value (review of #49)", () => {
    const life = sandbox.startLife(
      botWithTick("throw 'x'.repeat(2 ** 21);"),
      makeInfo({ opBudget: 100 }),
    );
    const reports = makeStates(3).map((s) => life.tick(s));
    for (const r of reports) expect(r.error?.length).toBeLessThan(2100);
    expect(reports[2]?.death?.message.length).toBeLessThan(2200);
  });

  it("describes thrown values without running bot code", () => {
    const thrown = [
      ["'plain string'", "uncaught plain string"],
      ["{ get message() { for (;;) {} } }", "Error: "],
      ["Object.assign(new RangeError('r'), { name: 'Custom' })", "Custom: r"],
    ];
    for (const [value, message] of thrown) {
      const [report] = run(botWithTick(`throw ${value};`), 1);
      expect(report?.outcome).toBe("error");
      expect(report?.error?.split("\n")[0]).toBe(message);
    }
  });
});

describe("log", () => {
  it("collects log() and console.log output per tick", () => {
    const reports = run(
      botWithTick(
        "log('a', 1, { x: [1, 2] }, null); console.warn('w', state.lifeTick); return { turn: 0 };",
      ),
      2,
    );
    expect(reports.map((r) => r.log)).toEqual([
      { lines: ['a 1 {"x":[1,2]} null', "w 0"], truncated: false },
      { lines: ['a 1 {"x":[1,2]} null', "w 1"], truncated: false },
    ]);
  });

  it("truncates exactly like createTickLog from the SDK", () => {
    const body = `
      log('héllo wörld 🐍');
      for (let i = 0; i < 50; i++) log('line', i, 'x'.repeat(i * 3), '🐍');
      log('after');
      return { turn: 0 };`;
    for (const limit of [10, 40, 100, 1024]) {
      const [report] = run(botWithTick(body), 1, makeInfo({ logLimitBytes: limit }));
      const reference = createTickLog(limit);
      reference.log("héllo wörld 🐍");
      for (let i = 0; i < 50; i++) reference.log("line", i, "x".repeat(i * 3), "🐍");
      reference.log("after");
      expect(report?.log).toEqual(reference.flush());
    }
  });

  it("counts an empty line as at least one byte (review of #49)", () => {
    const [report] = run(
      botWithTick("for (let i = 0; i < 5000; i++) log(''); return { turn: 0 };"),
      1,
    );
    expect(report?.outcome).toBe("ok");
    expect(report?.log.lines.length).toBe(1024);
    expect(report?.log.truncated).toBe(true);
  });

  it("keeps the lines logged before a timeout or an exception", () => {
    const [timeout] = run(botWithTick("log('before'); for (;;) {}"), 1);
    expect(timeout?.log.lines).toEqual(["before"]);
    const [error] = run(botWithTick("log('before'); null.x;"), 1);
    expect(error?.log.lines).toEqual(["before"]);
  });

  it("collects module and init output in loadLog", () => {
    const life = sandbox.startLife(
      "console.log('module'); export default { init() { console.log('init'); return {}; }, tick() { return { turn: 0 }; } };",
      makeInfo(),
    );
    expect(life.loadLog.lines).toEqual(["module", "init"]);
    expect(life.tick(oneState()).log.lines).toEqual([]);
    life.dispose();
  });
});

describe("determinism", () => {
  it("seeds Math.random per life", () => {
    const body = "log(Math.random(), Math.random()); return { turn: 0 };";
    const a = run(botWithTick(body), 2, makeInfo({ seed: 1 }));
    const b = run(botWithTick(body), 2, makeInfo({ seed: 1 }));
    const c = run(botWithTick(body), 2, makeInfo({ seed: 2 }));
    expect(a.map((r) => r.log)).toEqual(b.map((r) => r.log));
    expect(a[0]?.log.lines).not.toEqual(c[0]?.log.lines);
    expect(a[0]?.log.lines).not.toEqual(a[1]?.log.lines);
    const values = a.flatMap((r) => r.log.lines[0]?.split(" ").map(Number) ?? []);
    for (const v of values) expect(v >= 0 && v < 1).toBe(true);
  });

  it("has no clock, network, timers, eval or BigInt", () => {
    const [report] = run(
      botWithTick(`
        const names = ['Date', 'fetch', 'setTimeout', 'setInterval', 'queueMicrotask', 'performance',
          'eval', 'BigInt', 'BigInt64Array', 'Proxy', 'WeakRef', 'FinalizationRegistry',
          'SharedArrayBuffer', 'Atomics', 'require', 'process', 'std', 'os'];
        log(names.filter((n) => typeof globalThis[n] !== 'undefined').join(',') || 'none');
        for (const make of [
          () => Function('return 1'),
          () => (() => {}).constructor('return 1'),
          () => (function* () {}).constructor('yield 1'),
        ]) {
          try { make(); log('compiled'); } catch (e) { log(e.name); }
        }
        log(typeof new DataView(new ArrayBuffer(8)).getBigInt64);
        return { turn: 0 };`),
      1,
    );
    expect(report?.log.lines).toEqual(["none", "EvalError", "EvalError", "EvalError", "undefined"]);
  });

  it("cannot import anything", () => {
    for (const source of [
      "import x from 'node:fs'; export default { tick() {} };",
      "export * from 'node:fs'; export default { tick() {} };",
      botWithTick("import('node:fs'); return { turn: 0 };"),
    ]) {
      const life = sandbox.startLife(source, makeInfo());
      expect(life.death?.message, source).toMatch(/^bots can't import anything/);
    }
  });

  it("gives identical reports for identical runs, including budgets", async () => {
    const source = await bundleExampleBot();
    const other = await createSandbox();
    const states = makeStates(30);
    const lifeA = sandbox.startLife(source, makeInfo());
    const lifeB = other.startLife(source, makeInfo());
    expect(states.map((s) => lifeA.tick(s))).toEqual(states.map((s) => lifeB.tick(s)));
    lifeA.dispose();
    lifeB.dispose();
  });
});
