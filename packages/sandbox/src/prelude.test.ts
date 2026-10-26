import { beforeAll, describe, expect, it } from "vitest";
import { createSandbox, type Sandbox, type TickReport } from "./index.ts";
import { botWithTick, makeInfo, oneState } from "./testing/fixtures.ts";

// Unprotected, each of these runs for seconds to minutes inside one native call (the spike
// measured ~4 s for indexOf on a sparse array of 1e8). Protected, they must end within one tick.
const FAST_MS = 1000;

let sandbox: Sandbox;
beforeAll(async () => {
  sandbox = await createSandbox();
});

function tickOnce(body: string, prefix = ""): TickReport & { ms: number } {
  const life = sandbox.startLife(botWithTick(body, prefix), makeInfo());
  expect(life.death).toBeNull();
  const start = performance.now();
  const report = life.tick(oneState());
  const ms = performance.now() - start;
  life.dispose();
  return { ...report, ms };
}

/** Runs `expr` in a tick and returns what it logged (`log(expr)`), failing on any error. */
function evaluate(expr: string): string | undefined {
  const report = tickOnce(`log(${expr}); return { turn: 0 };`);
  expect(report.error).toBeNull();
  return report.log.lines[0];
}

describe("sparse arrays (spike regression)", () => {
  it("a.length = 1e8; a.indexOf(1) fails fast", () => {
    const report = tickOnce("const a = []; a.length = 1e8; return { turn: a.indexOf(1) };");
    expect(report.ms).toBeLessThan(FAST_MS);
    expect(report.outcome).toBe("error");
    expect(report.error).toMatch(
      /^RangeError: indexOf: length 100000000 is over the sandbox limit/,
    );
  });

  const scans = [
    "indexOf(1)",
    "lastIndexOf(1)",
    "includes(1)",
    "join()",
    "fill(0)",
    "reverse()",
    "copyWithin(0, 1)",
    "slice()",
    "splice(0, 1)",
    "shift()",
    "unshift(1)",
    "sort()",
    "toString()",
    "forEach(() => {})",
    "map((x) => x)",
    "filter(Boolean)",
    "some(Boolean)",
    "every(Boolean)",
    "reduce((a) => a, 0)",
    "concat([1])",
    "flat()",
    "keys().next()",
    "with(0, 1)",
    "toSorted()",
  ];
  for (const scan of scans) {
    it(`throws on a huge array for ${scan}`, () => {
      const report = tickOnce(
        `const a = []; a.length = 2 ** 32 - 1; a.${scan}; return { turn: 0 };`,
      );
      expect(report.ms).toBeLessThan(FAST_MS);
      expect(report.error).toMatch(/^RangeError: .*over the sandbox limit/);
    });
  }

  it("covers array methods borrowed for array-likes and typed arrays", () => {
    for (const target of [
      "{ length: 2 ** 40 }",
      "Object.create({ length: 1e9 })",
      "new Uint8Array(200000)",
    ]) {
      const report = tickOnce(`Array.prototype.indexOf.call(${target}, 1); return { turn: 0 };`);
      expect(report.error, target).toMatch(/over the sandbox limit/);
    }
    for (const target of [
      "{ get length() { return 1; } }",
      "{ length: { valueOf() { return 1e9; } } }",
    ]) {
      const report = tickOnce(`Array.prototype.includes.call(${target}, 1); return { turn: 0 };`);
      expect(report.error, target).toMatch(
        /^TypeError: sandbox: an array-like 'length' must be a plain number/,
      );
    }
  });

  it("covers typed arrays", () => {
    for (const scan of [
      "indexOf(1)",
      "lastIndexOf(1)",
      "includes(1)",
      "join()",
      "fill(0)",
      "reverse()",
      "copyWithin(0, 1)",
      "sort()",
      "slice()",
      "set([1])",
    ]) {
      const report = tickOnce(`const t = new Float64Array(200000); t.${scan}; return { turn: 0 };`);
      expect(report.error, scan).toMatch(/^RangeError: .*over the sandbox limit/);
    }
  });

  it("is not fooled by a length grown from valueOf during the call", () => {
    const report = tickOnce(`
      const a = [1, 2, 3];
      a.fill(0, { valueOf() { a.length = 1e9; return 0; } });
      const b = [1, 2, 3];
      const i = b.lastIndexOf(9, { valueOf() { b.length = 1e9; return 2; } });
      return { turn: a.length === 1e9 && i === -1 ? 1 : 0 };`);
    expect(report.ms).toBeLessThan(FAST_MS);
    expect(report.outcome).toBe("ok");
    expect(report.action.turn).toBe(1);
  });

  it("is not fooled by a getter that grows another array during concat or flat", () => {
    for (const call of ["a.concat(b)", "[a, b].flat()"]) {
      const report = tickOnce(`
        const b = [1];
        const a = [];
        Object.defineProperty(a, 0, { get() { b.length = 1e9; return 1; } });
        ${call};
        return { turn: 0 };`);
      expect(report.ms, call).toBeLessThan(FAST_MS);
      expect(report.outcome, call).not.toBe("ok");
    }
  });

  it("is not fooled by a Symbol.iterator getter in Array.from", () => {
    const report = tickOnce(`
      const a = { length: 1 };
      Object.defineProperty(a, Symbol.iterator, { get() { a.length = 1e7; return undefined; } });
      Array.from(a);
      return { turn: 0 };`);
    expect(report.ms).toBeLessThan(FAST_MS);
    expect(report.error).toMatch(/Symbol.iterator getter/);
  });
});

describe("native work budget", () => {
  // Each call is under the length cap, but thousands of them run between two interrupt checks.
  const loops = {
    "sparse slice": "const a = []; a.length = 1e5; for (;;) a.slice();",
    "caught errors": "const a = []; a.length = 1e8; for (;;) { try { a.indexOf(1); } catch {} }",
    "string search": "const s = 'a'.repeat(1e5); for (;;) s.indexOf('b');",
    "big string": "'x'.repeat(5e7);",
    "naive search": "const s = 'a'.repeat(1e5); s.indexOf('a'.repeat(1000) + 'b');",
    "typed array alloc": "for (;;) new Uint8Array(1e6);",
    "buffer alloc": "for (;;) new ArrayBuffer(1e6);",
    "typed copy": "const t = new Uint8Array(1e5); for (;;) new Uint8Array(t);",
    spread: "const a = new Array(5e4).fill(0); for (;;) Math.max(...a);",
    apply: "const a = new Array(5e4).fill(0); for (;;) Math.max.apply(null, a);",
    "object keys":
      "const o = {}; for (let i = 0; i < 1000; i++) o['k' + i] = i; for (;;) Object.keys(o);",
    JSON: "const s = JSON.stringify(new Array(5e4).fill(1)); for (;;) JSON.parse(s);",
    sort: "const a = new Array(5e4).fill(0).map((_, i) => String(i)); for (;;) a.sort();",
    "valueOf size":
      "let n = 0; const size = { valueOf: () => (n++ % 2 ? 1e7 : 1) }; for (;;) new ArrayBuffer(size);",
  };
  // Stopped by the work budget rather than by interrupt checks.
  const byWork = new Set([
    "sparse slice",
    "string search",
    "big string",
    "naive search",
    "typed array alloc",
    "buffer alloc",
    "typed copy",
    "spread",
    "apply",
    "sort",
  ]);
  for (const [name, body] of Object.entries(loops)) {
    it(`stops ${name} within one tick`, () => {
      const report = tickOnce(`${body} return { turn: 0 };`);
      expect(report.ms).toBeLessThan(FAST_MS);
      expect(report.outcome).toBe("timeout");
      if (byWork.has(name)) expect(report.error).toMatch(/native built-ins/);
    });
  }

  it("leaves room for normal bot work", () => {
    const report = tickOnce(`
      const pts = state.food.concat(state.food).map((f) => ({ ...f, d: Math.hypot(f.x, f.y) }));
      pts.sort((a, b) => a.d - b.d);
      const grid = new Float32Array(64 * 64).fill(0);
      const keys = Object.keys(state.self).join(',');
      const s = JSON.stringify(state);
      return { turn: pts[0].d > grid[0] && keys.includes('head') && JSON.parse(s).tick > 0 ? 0.1 : 0 };`);
    expect(report.outcome).toBe("ok");
    expect(report.action.turn).toBe(0.1);
    expect(report.work).toBeLessThan(1_000_000);
  });
});

describe("wrapped built-ins still behave", () => {
  const cases: [string, string][] = [
    ["[1, 2].concat(3, [4, [5]], 'x').length", "6"],
    [
      "JSON.stringify([1, 2].concat({ length: 1, 0: 'y', [Symbol.isConcatSpreadable]: true }))",
      '[1,2,"y"]',
    ],
    ["JSON.stringify([1, [2, [3, [4]]]].flat(Infinity))", "[1,2,3,4]"],
    ["JSON.stringify([1, [2, [3]]].flat())", "[1,2,[3]]"],
    ["JSON.stringify([1, 2].flatMap((x) => [x, x * 10]))", "[1,10,2,20]"],
    ["[3, 1, 2].sort().join('')", "123"],
    ["[10, 9, 1].sort().join(',')", "1,10,9"],
    ["Array.from({ length: 3 }, (_, i) => i * 2).join()", "0,2,4"],
    ["Array.from(new Set([1, 1, 2])).length", "2"],
    ["[...'ab'].join('-')", "a-b"],
    ["new Uint8Array([1, 2, 3]) instanceof Uint8Array", "true"],
    ["new (class extends Float32Array {})(4).length", "4"],
    ["Uint8Array.from([1, 2]).constructor === Uint8Array", "true"],
    ["Object.getPrototypeOf(Int8Array) === Object.getPrototypeOf(Uint8Array)", "true"],
    ["new Uint16Array(new ArrayBuffer(8), 2, 2).length", "2"],
    ["new ArrayBuffer(4, { maxByteLength: 16 }).maxByteLength", "16"],
    ["'abcabc'.replaceAll('b', '-')", "a-ca-c"],
    ["'a,b'.split(',').length", "2"],
    ["'x'.padStart(3, '-') + 'ab'.repeat(2)", "--xabab"],
    ["'Hello'.indexOf({ toString() { return 'l'; } })", "2"],
    ["'a1b2'.replace(/\\d/g, '#')", "a#b#"],
    ["JSON.stringify({ a: 1, b: [1, { c: 2, a: 3 }] }, ['a', 'b'])", '{"a":1,"b":[1,{"a":3}]}'],
    ["JSON.stringify({ a: 1 }, (k, v) => (typeof v === 'number' ? v + 1 : v))", '{"a":2}'],
    ["JSON.stringify({ a: [1] }, null, 2).length", "22"],
    ["Math.max.apply(null, [1, 5, 2])", "5"],
    ["Reflect.apply(Math.min, null, [4, 3])", "3"],
    ["Object.entries({ a: 1 }).join()", "a,1"],
    ["Array.prototype.map.call('ab', (c) => c + c).join('')", "aabb"],
    ["(function () { return Array.prototype.slice.call(arguments, 1).join(); })(1, 2, 3)", "2,3"],
    ["[1, 2, 3].indexOf.name + [].concat.length", "indexOf1"],
  ];
  for (const [expr, expected] of cases) {
    it(expr, () => {
      expect(evaluate(expr)).toBe(expected);
    });
  }
});
