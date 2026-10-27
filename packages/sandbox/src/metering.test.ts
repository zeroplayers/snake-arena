import { beforeAll, describe, expect, it } from "vitest";
import { createSandbox, DEFAULT_OP_BUDGET, type Sandbox, WORK_PER_OP } from "./index.ts";
import {
  botWithTick,
  bundleExampleBot,
  makeInfo,
  makeStates,
  oneState,
} from "./testing/fixtures.ts";

// Issue #60: the op budget counted interrupt polls, which come once per ~4 300 iterations whatever
// the loop body does, so a 300-statement body ran ~830 ms per tick unpunished. The shapes below
// stay just under the function size limit (see instrument.test.ts for bigger ones). The ceiling is
// generous for slow CI machines; the charged units are the exact, machine-independent check.
const CEILING_MS = 250;
const LIMIT = DEFAULT_OP_BUDGET * WORK_PER_OP;

let sandbox: Sandbox;
beforeAll(async () => {
  sandbox = await createSandbox();
});

const repeat = (n: number, f: (i: number) => string, sep = " ") =>
  Array.from({ length: n }, (_, i) => f(i)).join(sep);

function tickOnce(body: string, prefix = "") {
  const life = sandbox.startLife(botWithTick(body, prefix), makeInfo());
  expect(life.death, life.death?.message).toBeNull();
  const start = performance.now();
  const report = life.tick(oneState());
  const ms = performance.now() - start;
  life.dispose();
  return { ...report, ms };
}

/** A big function at the size limit, recursing to full stack depth before `then` runs. */
function deepInBigFunction(then: string): string {
  return `
    let depth = 0; function probe(n) { depth = n; probe(n + 1); }
    try { probe(0); } catch {}
    const max = Math.floor(depth * 0.9);
    function down(n, y) {
      if (n < 0) { ${repeat(360, (i) => `y = (y + ${i}) | 0;`)} }
      if (n > 0) return down(n - 1, y);
      ${then}
    }
    down(max, 0);`;
}

describe("cost meter: adversarial code shapes", () => {
  const shapes: Record<string, string> = {
    "long straight-line loop body": `let x = 0; for (;;) { ${repeat(280, (i) => `x = (x * 31 + ${i}) | 0;`)} }`,
    "long body in a while loop": `let x = 0; while (x !== -1) { ${repeat(360, (i) => `x = (x ^ ${i}) & 0xffff;`)} }`,
    "long body in do-while": `let x = 0; do { ${repeat(360, (i) => `x = (x + ${i}) & 0xffff;`)} } while (x !== -1);`,
    "long body behind labels and continue": `let x = 0; outer: for (;;) { for (let i = 0; i < 2; i++) { ${repeat(300, (i) => `x = (x + ${i}) | 0;`)} if (i) continue outer; } }`,
    "deep expression tree": `let x = 1; for (;;) { x = ${"(".repeat(150)}x${repeat(150, (i) => ` * 3 + ${i})`, "")} | 0; }`,
    "ternary chain": `let x = 1; for (;;) { x = ${repeat(150, (i) => `x === ${i} ? ${i} :`, "")} 0; }`,
    "huge object literal": `let o; for (;;) { o = { ${repeat(700, (i) => `k${i}: ${i}`, ", ")} }; }`,
    "huge array literal": `let a; for (;;) { a = [${repeat(900, (i) => `${i}`, ",")}]; }`,
    "nested literals": `let a; for (;;) { a = [${repeat(110, (i) => `{ v: [${i}] }`, ",")}]; }`,
    "long chain of calls": `${repeat(100, (i) => `function f${i}(x) { return ${i === 99 ? "x" : `f${i + 1}(x + 1)`}; }`)} for (;;) f0(1);`,
    "wide calls": `function f() {} for (;;) { ${repeat(350, () => "f(1, 2, 3);")} }`,
    closures: `let f; for (;;) { ${repeat(120, (i) => `f = () => ${i};`)} }`,
    classes: `let C; for (;;) { C = class { a() {} b() {} static c = 1; }; }`,
    "class fields": `class A { ${repeat(300, (i) => `f${i} = ${i};`)} } let a; for (;;) a = new A();`,
    "string building": `let s = ''; for (;;) { s += 'x'; if (s.length > 1e5) s = ''; }`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bot code with a template literal
    "template literals": "let s = ''; const a = 'x'; for (;;) { s = `${a}${a}${a}${a}`; }",
    "object spread": `const o = { ${repeat(500, (i) => `k${i}: ${i}`, ", ")} }; let b; for (;;) b = { ...o };`,
    "object rest": `const o = { ${repeat(500, (i) => `k${i}: ${i}`, ", ")} }; for (;;) { const { k0, ...rest } = o; }`,
    "for-in that breaks at once": `const o = { ${repeat(500, (i) => `k${i}: ${i}`, ", ")} }; for (;;) { for (const k in o) break; }`,
    "for-in over a deep prototype": `let o = {}; for (let i = 0; i < 200; i++) { o = Object.create(o); o['k' + i] = i; } for (;;) { for (const k in o) break; }`,
    "array spread": `const a = new Array(5e4).fill(0); let b; for (;;) b = [...a];`,
    "call spread": `const a = new Array(5e4).fill(0); function f() {} for (;;) f(...a);`,
    apply: `const a = new Array(5e4).fill(0); function f() {} for (;;) f.apply(null, a);`,
    "Reflect.apply": `const a = new Array(5e4).fill(0); function f() {} for (;;) Reflect.apply(f, null, a);`,
    "for-of that breaks at once": `const a = new Array(5e4).fill(0); for (;;) { for (const x of a) break; }`,
    "default parameters that recurse": `function f(a = f()) {} for (;;) { try { f(); } catch {} }`,
    "parameter pattern that throws": `function f({ ${repeat(200, (i) => `a${i}`, ", ")}, z: { q } }) {} for (;;) { try { f({}); } catch {} }`,
    "exceptions at full stack depth": deepInBigFunction("for (;;) { try { null.x; } catch {} }"),
    "new Error at full stack depth": deepInBigFunction("for (;;) new Error('x');"),
    "stack overflows in a big function": `function down(n, y) { if (n < 0) { ${repeat(360, (i) => `y = (y + ${i}) | 0;`)} } return down(n + 1, y); } for (;;) { try { down(0, 0); } catch {} }`,
    "finally that swallows exceptions": `function down(n) { return down(n + 1); } for (;;) { try { down(0); } finally { continue; } }`,
    getters: `const o = { get g() { return ${repeat(100, (i) => `${i}`, " + ")}; } }; let x; for (;;) x = o.g;`,
    generators: `function* g() { for (;;) { ${repeat(300, (i) => `yield ${i};`)} } } const it = g(); for (;;) it.next();`,
  };
  for (const [name, body] of Object.entries(shapes)) {
    it(`stops ${name} within one tick`, () => {
      const report = tickOnce(`${body}\nreturn { turn: 0.5 };`);
      expect(report.outcome).toBe("timeout");
      expect(report.action.turn).toBe(0);
      expect(report.ms).toBeLessThan(CEILING_MS);
      if (/cost units/.test(report.error ?? "")) {
        expect(report.work).toBeGreaterThan(LIMIT);
        // One charge past the limit at most: an exception at full depth in a function at the size
        // limit is the largest single charge (~8 M units).
        expect(report.work).toBeLessThan(LIMIT + 10_000_000);
      } else {
        expect(report.error).toMatch(/interrupts/);
      }
    });
  }

  it("stops the same shapes at module load", () => {
    const body = `let x = 0; for (;;) { ${repeat(1000, (i) => `x = (x * 31 + ${i}) | 0;`)} }`;
    const start = performance.now();
    const life = sandbox.startLife(`${body}\nexport default { tick() {} };`, makeInfo());
    expect(performance.now() - start).toBeLessThan(CEILING_MS * 4); // the load budget is 10×
    expect(life.death).toMatchObject({ fault: "timeout", reason: "load" });
  });

  it("charges straight-line module code against the load budget", () => {
    const table = `[${repeat(50_000, (i) => `${i}`, ",")}]`;
    const source = `const t = ${table}; export default { tick() { return { turn: 0 }; } };`;
    // 50 000 elements × 5 weight × 8 units ≈ 2 M units: over a 1-op load budget, under the default.
    expect(sandbox.startLife(source, makeInfo(), { initOpBudget: 1 }).death).toMatchObject({
      fault: "timeout",
      reason: "load",
    });
    const life = sandbox.startLife(source, makeInfo());
    expect(life.death).toBeNull();
    life.dispose();
  });

  it("charges the same units on every run", () => {
    const body = `let x = 0; for (let i = 0; i < 300; i++) { ${repeat(100, (i) => `x = (x + ${i}) | 0;`)} try { null.x; } catch (e) {} } const o = { ...state.self }; for (const k in o) x++; return { turn: x > 0 ? 0.1 : 0 };`;
    const runs = [0, 1].map(() => {
      const life = sandbox.startLife(botWithTick(body), makeInfo());
      const reports = makeStates(5).map((s) => life.tick(s));
      life.dispose();
      return reports;
    });
    expect(runs[0]).toEqual(runs[1]);
    expect(runs[0]?.every((r) => r.outcome === "ok" && r.work > 1_000_000)).toBe(true);
  });
});

describe("cost meter: honest bots", () => {
  it("leaves the SDK example bot far under budget", async () => {
    const life = sandbox.startLife(await bundleExampleBot(), makeInfo());
    const reports = makeStates(100).map((s) => life.tick(s));
    life.dispose();
    expect(reports.every((r) => r.outcome === "ok")).toBe(true);
    const most = Math.max(...reports.map((r) => r.work));
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThan(LIMIT / 20);
  });

  it("charges a typical tick a small share of the budget", () => {
    const report = tickOnce(`
      const { head } = state.self;
      let best = null, bestD = Infinity;
      for (const f of state.food) {
        const d = Math.hypot(f.x - head.x, f.y - head.y);
        if (d < bestD) { bestD = d; best = f; }
      }
      let danger = 0;
      for (const s of state.snakes) for (const p of s.segments) {
        if (Math.hypot(p.x - head.x, p.y - head.y) < 20) danger++;
      }
      const want = best ? Math.atan2(best.y - head.y, best.x - head.x) : state.self.angle;
      return { turn: danger ? 1 : Math.max(-1, Math.min(1, want - state.self.angle)) };`);
    expect(report.outcome).toBe("ok");
    expect(report.work).toBeLessThan(LIMIT / 100);
  });
});
