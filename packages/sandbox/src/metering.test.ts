import { beforeAll, describe, expect, it } from "vitest";
import {
  createSandbox,
  DEFAULT_OP_BUDGET,
  instrument,
  type Sandbox,
  WORK_PER_OP,
} from "./index.ts";
import { MAX_STRING_LENGTH } from "./instrument.ts";
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

/**
 * Finds the recursion depth that fills the stack. It runs at module load: its one exception at
 * full depth costs more than a tick's budget, so probing inside the tick (as the first version
 * of these tests did) timed out before the code under test ever ran (review of #62).
 */
const PROBE =
  "let depth = 0; function probe(n) { depth = n; probe(n + 1); } try { probe(0); } catch {}";

/**
 * A big function at the size limit, recursing to 90% of the stack depth before `then` runs (in
 * a small function of its own, so every body gets the same depth). It logs "deep" first, so a
 * test can tell the code under test was reached.
 */
function deepInBigFunction(then: string): string {
  return `
    const max = Math.floor(depth * 0.9);
    function bottom() {
      log("deep");
      ${then}
    }
    function down(n) {
      let y = 0;
      if (n < 0) { ${repeat(360, (i) => `y = (y + ${i}) | 0;`)} }
      if (n > 0) return down(n - 1);
      return bottom();
    }
    down(max);`;
}

/** Expects a tick stopped by the cost meter within one tick, with at most one charge past it. */
function expectStopped(report: ReturnType<typeof tickOnce>, what: string): void {
  expect(report.outcome, what).toBe("timeout");
  expect(report.error, what).toMatch(/cost units/);
  expect(report.action.turn, what).toBe(0);
  expect(report.work, what).toBeGreaterThan(LIMIT);
  // An exception at full depth in a function at the size limit is the largest single charge.
  expect(report.work, what).toBeLessThan(LIMIT + 10_000_000);
  expect(report.ms, what).toBeLessThan(CEILING_MS);
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
    "stack overflows in a big function": `function down(n) { let y = 0; if (n < 0) { ${repeat(360, (i) => `y = (y + ${i}) | 0;`)} } return down(n + 1); } for (;;) { try { down(0); } catch {} }`,
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

  it("probes the stack depth at load", () => {
    const report = tickOnce("log(String(depth)); return { turn: 0 };", PROBE);
    expect(report.outcome).toBe("ok");
    expect(Number(report.log.lines[0])).toBeGreaterThan(300);
  });

  // Review of #62: these never reached their loop (the probe ran in the tick), so all three
  // reported the same work. Each must now reach full depth and then be stopped by its charges.
  const deep: Record<string, string> = {
    "caught exceptions": "for (;;) { try { null.x; } catch {} }",
    "new Error": "for (;;) new Error('x');",
    "a finally that swallows": "for (;;) { try { null.x; } finally { continue; } }",
  };
  for (const [name, then] of Object.entries(deep)) {
    it(`stops ${name} at full stack depth in a big function`, () => {
      const report = tickOnce(`${deepInBigFunction(then)}\nreturn { turn: 0.5 };`, PROBE);
      expect(report.log.lines, name).toEqual(["deep"]);
      expectStopped(report, name);
    });
  }

  // Review of #62: Promise code caught these exceptions in C, so they were never charged
  // (23 s and 20 s per tick). Promise is gone: the same code now fails at once.
  const promises: Record<string, string> = {
    "a throwing thenable given to Promise.resolve":
      "const t = { get then() { null.x; } }; for (;;) Promise.resolve(t);",
    "a throwing iterator given to Promise.all":
      "for (;;) Promise.all({ [Symbol.iterator]() { return { next() { null.x; } }; } });",
  };
  for (const [name, then] of Object.entries(promises)) {
    it(`has no Promise to swallow ${name}`, () => {
      const report = tickOnce(`${deepInBigFunction(then)}\nreturn { turn: 0.5 };`, PROBE);
      expect(report.log.lines, name).toEqual(["deep"]);
      expect(report.outcome, name).toBe("error");
      expect(report.error, name).toMatch(/^ReferenceError: .*Promise/);
      expect(report.ms, name).toBeLessThan(CEILING_MS);
    });
  }

  // Found while fixing the review of #62: after an exception, for-of closes the iterator and
  // ignores what its return() throws; return() can run code that does the same again, so one
  // exception per level was built before any was charged (1.1 s per tick for 200 levels).
  const closes: Record<string, string> = {
    "an exception in a for-of body": "for (const x of it) { x.y; }",
    "an exception in a for-of head": "for (const [a] of it) {}",
    "an exception storing a for-of value": "for ([o.a] of it);",
  };
  for (const [name, loop] of Object.entries(closes)) {
    it(`charges ${name} before the iterator is closed`, () => {
      const report = tickOnce(
        `const o = {}; const max = Math.floor(depth * 0.5);
        function nest(k) {
          const it = { [Symbol.iterator]() { return this; }, next() { return { value: null, done: false }; },
            return() { if (k > 0) nest(k - 1); null.y; } };
          ${loop}
        }
        function down(n) { if (n > 0) return down(n - 1); log("deep"); for (;;) { try { nest(200); } catch {} } }
        down(max);
        return { turn: 0.5 };`,
        PROBE,
      );
      expect(report.log.lines, name).toEqual(["deep"]);
      expectStopped(report, name);
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

describe("cost meter: strings (review of #62)", () => {
  // Comparing, hashing or converting a string runs in C in time linear in its length (up to ~15 ns
  // per char), as one bytecode. The review's repros used strings of 2 M chars and ran for 29–156 s
  // per tick; strings are now capped, and each of these operations is charged by length.
  const N = MAX_STRING_LENGTH;
  const max = `const X = 'x'.repeat(${N - 1}); const B = X + 'y', C = X + 'z'; const K = X + 'x';`;
  const spaces = `const S = ' '.repeat(${N - 1}) + '1'; const D = '0.' + '1'.repeat(${N - 2});`;
  const many = "const strs = new Array(100).fill(S); const keys = new Array(100).fill(K);";
  const prefix = `${max} ${spaces} ${many}`;
  const rows: Record<string, string> = {
    // The review's table.
    "=== on two strings that differ at the end": "for (;;) B === C;",
    "switch on a long string": "for (;;) switch (B) { case C: break; }",
    "Map.get with a long key": "const m = new Map([['y', 1]]); for (;;) m.get(K);",
    "Set.has with a long key": "const s = new Set(['y']); for (;;) s.has(K);",
    "+s on spaces and a digit": "for (;;) +S;",
    // The same costs through other syntax.
    "+s on a long decimal": "for (;;) +D;",
    arithmetic: "for (;;) D * 1;",
    relational: "for (;;) D < 1;",
    "loose equality": "for (;;) D == 1;",
    updates: "let v; for (;;) { v = D; v++; }",
    "compound assignment to a member": "const o = {}; for (;;) { o.v = D; o.v -= 1; }",
    "a key equal to an existing one": "const o = { [K]: 1 }; const k = X + 'x'; for (;;) o[k];",
    in: "const o = { [K]: 1 }; const k = X + 'x'; for (;;) k in o;",
    "a built-in argument": "for (;;) Math.floor(D);",
    "a returned string": "const f = () => D; for (;;) Math.floor(f());",
    valueOf: "const v = { valueOf() { return D; } }; for (;;) v * 1;",
    "a String object": "const v = new String(D); for (;;) v * 1;",
    "an array": "const v = [D]; for (;;) v * 1;",
    "a typed array store": "const t = new Float64Array(1); for (;;) t[0] = D;",
    "a length store": "const a = []; for (;;) a.length = S;",
    "a store through destructuring": "const t = new Float64Array(1); for (;;) [t[0]] = strs;",
    "a built-in as a callback": "for (;;) strs.map(Number);",
    "a spread into a built-in": "for (;;) Math.max(...strs);",
    apply: "for (;;) Math.max.apply(null, strs);",
    "a typed array built from strings": "for (;;) new Float64Array(strs);",
    "an iterator with its own next()":
      "const it = { [Symbol.iterator]() { let i = 0; return { next: () => ({ value: D, done: i++ > 100 }) }; } }; for (;;) new Float64Array(it);",
    "a replaced array iterator":
      "Array.prototype[Symbol.iterator] = function* () { for (let i = 0; i < 100; i++) yield D; }; for (;;) new Float64Array([0]);",
    "a Set built from strings": "for (;;) new Set(keys);",
    "Object.fromEntries": "const e = [[K, 1]]; for (;;) Object.fromEntries(e);",
    sort: "const a = new Array(100).fill(K); for (;;) a.sort();",
    "a regex lastIndex": "const re = /x/g; for (;;) { re.lastIndex = S; re.test(''); }",
    "a bound built-in": "const f = Math.floor.bind(null, D); for (;;) f();",
    "Object.assign into a typed array":
      "const t = new Float64Array(1); const src = { 0: D }; for (;;) Object.assign(t, src);",
  };
  for (const [name, body] of Object.entries(rows)) {
    it(`stops ${name} within one tick`, () => {
      const report = tickOnce(`${body}\nreturn { turn: 0.5 };`, prefix);
      expectStopped(report, name);
    });
  }

  it("hands built-ins a copy of what it charged", () => {
    // A getter runs while the prelude checks the arguments of apply, and swaps the elements it
    // already checked for long strings (through the prototype): 0.5 s per tick before the copy.
    const report = tickOnce(
      `const a = new Array(51).fill(1);
      Object.defineProperty(a, 50, { get() { for (let i = 0; i < 50; i++) delete a[i]; Object.setPrototypeOf(a, p); return 1; } });
      for (;;) { for (let i = 0; i < 50; i++) a[i] = 1; Object.setPrototypeOf(a, Array.prototype); Math.max.apply(null, a); }
      return { turn: 0.5 };`,
      `${prefix} const p = {}; for (let i = 0; i < 50; i++) p[i] = D;`,
    );
    expect(report.outcome).toBe("timeout");
    expect(report.ms).toBeLessThan(CEILING_MS);
  });

  const tooLong: Record<string, string> = {
    "+": "let s = 'x'; for (;;) s = s + s;",
    "+=": "let s = 'x'; for (;;) s += s;",
    "+= on a member": "const o = { s: 'x' }; for (;;) o.s += o.s;",
    "+= on a computed member": "const o = { s: 'x' }; const k = 's'; for (;;) o[k] += o[k];",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bot code with a template literal
    "a template": "let s = 'x'; for (;;) s = `${s}${s}`;",
    repeat: "'x'.repeat(N + 1);",
    padStart: "'x'.padStart(N + 1);",
    concat: "const s = 'x'.repeat(N); s.concat('y');",
    join: "new Array(N + 2).join('x');",
    "JSON.stringify": "JSON.stringify('x'.repeat(N));",
    "String.fromCharCode": "String.fromCharCode(...new Array(N + 1).fill(65));",
    "a Symbol description": "Symbol('x'.repeat(N));",
    // Re-review of #62: escape was copied from the native unguarded and grew a string 4× per
    // call (16 K → 65 K → …).
    "RegExp.escape": "RegExp.escape(' '.repeat(N / 4 + 1));",
    "a RegExp source": "new RegExp('/'.repeat(N / 2 + 1)).source;",
    "String.raw": "String.raw({ raw: ['x'.repeat(N), 'y'] }, '');",
    "a join of numbers": "new Array(N / 2 + 1).fill(0).join();",
    "a typed array join": "new Float64Array(N / 2 + 1).join();",
  };
  for (const [name, body] of Object.entries(tooLong)) {
    it(`caps strings built by ${name}`, () => {
      const report = tickOnce(`const N = ${N}; ${body}\nreturn { turn: 0.5 };`);
      expect(report.outcome, name).toBe("error");
      expect(report.error, name).toMatch(/^RangeError: .*over the sandbox limit of 16384/);
      expect(report.ms, name).toBeLessThan(CEILING_MS);
    });
  }

  it("never stores a string over the cap", () => {
    const report = tickOnce(`
      let s = 'x'.repeat(10000);
      const o = { s }, a = [s], k = 's';
      for (const f of [() => { s += s; }, () => { o.s += s; }, () => { o[k] += s; }, () => { a[0] += s; }]) {
        try { f(); } catch {}
      }
      return { turn: (s.length + o.s.length + a[0].length) / 1e5 };`);
    expect(report.outcome).toBe("ok");
    expect(report.action.turn).toBeCloseTo(0.3);
  });

  it("rejects longer literals and names", () => {
    for (const source of [
      `const s = "${"x".repeat(N + 1)}";`,
      `const s = \`${"x".repeat(N + 1)}\`;`,
      `const ${"x".repeat(N + 1)} = 1;`,
    ]) {
      const result = instrument(`${source} export default { tick() {} };`);
      expect(result.ok).toBe(false);
    }
  });

  it("cuts long stacks to the cap", () => {
    const report = tickOnce(
      "let len = 0; try { probe(0); } catch (e) { len = e.stack.length; } return { turn: len / 1e5 };",
      PROBE,
    );
    expect(report.action.turn).toBeCloseTo(N / 1e5);
  });
});

describe("cost meter: numbers to strings (re-review of #62)", () => {
  // Converting a number to a string costs ~0.2–0.8 µs, but up to ~36 µs for a value printed
  // with a 3-digit exponent (denormals) and ~80 µs in other radixes. It was charged a flat
  // amount, so these ran until the interrupt backstop: up to 1.3 s per tick (3.5 s for a join).
  const x = "const x = 5e-324 * 7; const big = 1.79e308; const o = {};";
  const rows: Record<string, string> = {
    String: "for (;;) String(x);",
    toString: "for (;;) x.toString();",
    "toString with a radix": "for (;;) x.toString(7);",
    "toString(3) of a large number": "for (;;) big.toString(3);",
    toFixed: "for (;;) big.toFixed(100);",
    toPrecision: "for (;;) x.toPrecision(100);",
    toExponential: "for (;;) x.toExponential(100);",
    toLocaleString: "for (;;) x.toLocaleString();",
    "a number key": "for (;;) o[x];",
    "a number key through a temporary": "for (;;) o[x * 1];",
    "a number key of a numeric local": "let k = x; for (;;) o[k];",
    "in with a number": "for (;;) x in o;",
    "a computed key in a literal": "for (;;) ({ [x]: 1 });",
    "an object key whose toString returns a number":
      "const k = { toString: () => x }; for (;;) o[k];",
    "+ with a string": "let s; for (;;) s = '' + x;",
    "+ with the number on the left": "let s; for (;;) s = x + '';",
    "+= of a string": "let s; for (;;) { s = ''; s += x; }",
    "+ with an object converting to a number":
      "const v = { valueOf: () => x }; let s; for (;;) s = v + '';",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bot code with a template literal
    "a template": "let s; for (;;) s = `${x}`;",
    "a typed array join": "const t = new Float64Array(200).fill(x); for (;;) t.join();",
    "a typed array toString": "const t = new Float64Array(200).fill(x); for (;;) t.toString();",
    "a typed array toLocaleString":
      "const t = new Float64Array(200).fill(x); for (;;) t.toLocaleString();",
    "an array join": "const a = new Array(200).fill(x); for (;;) a.join();",
    "an array join of objects":
      "const a = new Array(200).fill({ toString: () => x }); for (;;) a.join();",
    "an array toLocaleString": "const a = new Array(200).fill(x); for (;;) a.toLocaleString();",
    "a sort without a comparator": "const a = new Array(200).fill(x); for (;;) a.sort();",
    "Array.prototype.join on a typed array":
      "const t = new Float64Array(200).fill(x); for (;;) Array.prototype.join.call(t);",
    "JSON.stringify": "const a = new Array(200).fill(x); for (;;) JSON.stringify(a);",
    "JSON.stringify of Number objects":
      "const a = new Array(200).fill(new Number(x)); for (;;) JSON.stringify(a);",
    "a string method's argument": "for (;;) 'a'.indexOf(x);",
    "padStart's filler": "for (;;) 'a'.padStart(2, x);",
    concat: "for (;;) 'a'.concat(x);",
    parseInt: "for (;;) parseInt(x);",
    "Number.parseFloat": "for (;;) Number.parseFloat(x);",
    "an Error message": "for (;;) new Error(x);",
    "a Symbol description": "for (;;) Symbol(x);",
    "a RegExp pattern": "for (;;) new RegExp(x);",
    "a regex input": "const re = /y/; for (;;) re.test(x);",
    hasOwnProperty: "for (;;) o.hasOwnProperty(x);",
    "Reflect.get": "for (;;) Reflect.get(o, x);",
    "Object.fromEntries": "const e = [[x, 1]]; for (;;) Object.fromEntries(e);",
    "Object.groupBy": "const a = [1]; for (;;) Object.groupBy(a, () => x);",
    "String.raw": "const t = { raw: ['a', 'b'] }; for (;;) String.raw(t, x);",
    "a native callback": "const a = new Array(200).fill(x); for (;;) a.map(String);",
    "console.log": "for (;;) log(x);",
  };
  for (const [name, body] of Object.entries(rows)) {
    it(`stops ${name} within one tick`, () => {
      const report = tickOnce(`${body}\nreturn { turn: 0.5 };`, x);
      expectStopped(report, name);
    });
  }

  it("charges a number key's conversion by value", () => {
    const keys = (k: string) =>
      tickOnce(
        `const o = {}; let k = ${k}; for (let i = 0; i < 100; i++) o[k]; return { turn: 0 };`,
      ).work;
    const int = keys("7");
    expect(keys("0.5") - int).toBeGreaterThan(100 * 700);
    expect(keys("5e-324") - int).toBeGreaterThan(100 * 39_000);
  });
});

describe("cost meter: regex output (re-review of #62)", () => {
  // Lookahead captures overlap, so a global regex returns n² / 2 chars of captures, built (and
  // scanned for) without interrupt polls: 81–300 ms per tick before.
  const prefix = "const s = 'x'.repeat(4000); const h = 'x'.repeat(2000);";
  const rows: Record<string, string> = {
    "replace with overlapping captures": "for (;;) s.replace(/(?=(x*))/g, '$1');",
    "split with overlapping captures": "for (;;) s.split(/(?=(x*))/);",
    "matchAll with overlapping captures": "for (;;) [...h.matchAll(/(?=(x*))/g)];",
    "match with overlapping captures": "for (;;) s.match(/(?=(x*))/g);",
    "a replace function given overlapping captures": "for (;;) s.replace(/(?=(x*))/g, () => '');",
    "exec of overlapping captures":
      "const re = /(?=(x*))/g; for (;;) { re.lastIndex = 0; for (let i = 0; i < 4000; i++) re.exec(s); }",
  };
  for (const [name, body] of Object.entries(rows)) {
    it(`stops ${name} within one tick`, () => {
      const report = tickOnce(`${body}\nreturn { turn: 0.5 };`, prefix);
      expectStopped(report, name);
    });
  }

  // The Symbol methods trust what exec returns, and split and matchAll construct their regex
  // through the species constructor: a bot's versions could feed them huge captures.
  const replaced: Record<string, string> = {
    "a replaced exec":
      "RegExp.prototype.exec = function () { return null; }; 'a'.replace(/a/g, 'b');",
    "an own exec": "const re = /a/g; re.exec = () => null; 'a'.replace(re, 'b');",
    "a subclass with its own exec":
      "class R extends RegExp { exec() { return null; } } 'a'.match(new R('a', 'g'));",
    "a species constructor": "class R extends RegExp {} 'abc'.split(new R('b'));",
    "a replaced flags getter":
      "Object.defineProperty(RegExp.prototype, 'flags', { get: () => 'g' }); 'a'.split(/a/);",
  };
  for (const [name, body] of Object.entries(replaced)) {
    it(`refuses ${name}`, () => {
      const report = tickOnce(`${body}\nreturn { turn: 0.5 };`);
      expect(report.outcome, name).toBe("error");
      expect(report.error, name).toMatch(/^TypeError: sandbox: RegExp methods need the built-in/);
    });
  }
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
