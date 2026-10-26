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
    // Review of #49: natives that walk every key or char of their input.
    descriptors: "const s = 'x'.repeat(2e5); for (;;) Object.getOwnPropertyDescriptors(s);",
    assign: "const s = 'x'.repeat(2e5); for (;;) Object.assign({}, s);",
    "String.raw": "const raw = new Uint8Array(1e5); for (;;) String.raw({ raw });",
    "Object.values": "const s = 'x'.repeat(2e5); for (;;) Object.values(s);",
    "Object.entries": "const a = new Array(5e4).fill(0); for (;;) Object.entries(a);",
    isFrozen: "const a = new Array(5e4).fill(0); for (;;) Object.isFrozen(a);",
    parseFloat: "const s = '1'.repeat(1e6); for (;;) parseFloat(s);",
    RegExp: "const p = 'a'.repeat(1e5); for (;;) new RegExp(p);",
    "join separator":
      "const a = new Array(100).fill(1); const sep = 'x'.repeat(1e5); for (;;) a.join(sep);",
    "string indexOf in array":
      "const s = 'x'.repeat(1e6); const a = new Array(100).fill(s + 'y'); for (;;) a.indexOf(s + 'z');",
    bind: "const args = new Array(6e4).fill(0); for (;;) Math.max.bind(null, ...args);",
    // Follow-up review of #49: built-ins that copy, convert or quote a whole string.
    "JSON.stringify string": "const s = 'x'.repeat(1e5); for (;;) JSON.stringify(s);",
    "JSON.stringify key": "const o = { ['k'.repeat(1e5)]: 1 }; for (;;) JSON.stringify(o);",
    "JSON.stringify escapes":
      "const s = String.fromCharCode(1).repeat(1e4); for (;;) JSON.stringify(s);",
    "JSON.stringify String object":
      "const s = new String('x'.repeat(1e5)); for (;;) JSON.stringify(s);",
    normalize: "const s = String.fromCharCode(101, 769).repeat(5e3); for (;;) s.normalize('NFC');",
    toUpperCase: "const s = 'x'.repeat(1e5); for (;;) s.toUpperCase();",
    toLowerCase: "const s = 'X'.repeat(1e5); for (;;) s.toLowerCase();",
    localeCompare: "const s = 'x'.repeat(1e5); for (;;) s.localeCompare(s);",
    encodeURIComponent:
      "const s = String.fromCharCode(233).repeat(1e4); for (;;) encodeURIComponent(s);",
    escape: "const s = String.fromCharCode(233).repeat(1e4); for (;;) escape(s);",
    decodeURIComponent: "const s = '%C3%A9'.repeat(1e4); for (;;) decodeURIComponent(s);",
    "split into chars": "const s = 'x'.repeat(1e4); for (;;) s.split('');",
    "string spread": "const s = 'x'.repeat(1e4); for (;;) [...s];",
    "Array.from string": "const s = 'x'.repeat(1e4); for (;;) Array.from(s);",
    "global match": "const s = 'x'.repeat(1e4); for (;;) s.match(/x/g);",
    "matchAll spread": "const s = 'x'.repeat(1e4); for (;;) [...s.matchAll(/x/g)];",
    "regex split": "const s = 'x,'.repeat(1e4); for (;;) s.split(/,/);",
    "long replacement": "const r = 'y'.repeat(1e5); for (;;) 'xxxxxxxxxx'.replaceAll('x', r);",
    "replacement prefix": "const s = 'x'.repeat(1000); for (;;) s.replaceAll('x', '$`');",
    "replacer function": "const r = 'y'.repeat(1e5); for (;;) 'xxxxxxxxxx'.replace(/x/g, () => r);",
    "Symbol.replace": "const r = 'y'.repeat(1e5); for (;;) /x/g[Symbol.replace]('xxxxxxxxxx', r);",
    "fake global":
      "const s = 'x'.repeat(1e4); const rx = /x/; Object.defineProperty(rx, 'global', { value: true }); for (;;) s.match(rx);",
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
    "descriptors",
    "assign",
    "String.raw",
    "Object.values",
    "Object.entries",
    "isFrozen",
    "parseFloat",
    "RegExp",
    "join separator",
    "string indexOf in array",
    "bind",
    "JSON.stringify escapes",
    "normalize",
    "toUpperCase",
    "toLowerCase",
    "localeCompare",
    "encodeURIComponent",
    "escape",
    "decodeURIComponent",
    "split into chars",
    "string spread",
    "Array.from string",
    "long replacement",
    "replacement prefix",
    "replacer function",
    "Symbol.replace",
  ]);
  for (const [name, body] of Object.entries(loops)) {
    it(`stops ${name} within one tick`, () => {
      const report = tickOnce(`${body} return { turn: 0 };`);
      expect(report.ms).toBeLessThan(FAST_MS);
      expect(report.outcome).toBe("timeout");
      if (byWork.has(name)) expect(report.error).toMatch(/native built-ins/);
    });
  }

  it("stops set algebra within one tick", () => {
    const report = tickOnce(
      "for (;;) a.union(b); return { turn: 0 };",
      "const a = new Set(), b = new Set(); for (let i = 0; i < 5e4; i++) { a.add(i); b.add(-i); }",
    );
    expect(report.ms).toBeLessThan(FAST_MS);
    expect(report.error).toMatch(/native built-ins/);
  });

  it("stops the review repro: JSON.stringify of a 4 MB string 50 times", () => {
    const report = tickOnce(
      "for (let j = 0; j < 50; j++) JSON.stringify(s); return { turn: 0.5 };",
      "const s = 'x'.repeat(4e6);",
    );
    expect(report.ms).toBeLessThan(FAST_MS);
    expect(report.outcome).toBe("timeout");
    expect(report.error).toMatch(/native built-ins/);
    expect(report.action.turn).not.toBe(0.5);
  });

  const collections =
    "const set = new Set(), map = new Map(); for (let i = 0; i < 5e4; i++) { set.add(i); map.set(i, i); }";
  for (const [name, body] of [
    ["Set spread", "[...set]"],
    ["Map spread", "[...map]"],
    ["Array.from Set", "Array.from(set)"],
    ["new Set(set)", "new Set(set)"],
    ["Map keys", "[...map.keys()]"],
  ]) {
    it(`stops ${name} within one tick`, () => {
      const report = tickOnce(`for (;;) ${body}; return { turn: 0 };`, collections);
      expect(report.ms).toBeLessThan(FAST_MS);
      expect(report.error).toMatch(/native built-ins/);
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
    ["JSON.stringify(Object.assign({ a: 1 }, 'xy', [3]))", '{"0":3,"1":"y","a":1}'],
    ["Object.keys(Object.getOwnPropertyDescriptors('ab')).join()", "0,1,length"],
    ["String.raw({ raw: ['a', 'b', 'c'] }, 1, 2)", "a1b2c"],
    ["[...new Set([1, 2]).union(new Set([2, 3]))].join()", "1,2,3"],
    ["new Set([1]).isSubsetOf(new Set([1, 2]))", "true"],
    ["parseInt('ff', 16) + parseFloat('1.5') + Number(isNaN('x'))", "257.5"],
    ["encodeURIComponent('a b') + decodeURI('%41')", "a%20bA"],
    ["new RegExp('a+', 'g').test('caa') && RegExp('b').source", "b"],
    ["Object.isFrozen(Object.freeze([1])) && Object.entries({ a: 1 }).length", "1"],
    ["Math.max.bind(null, 1, 2)(3)", "3"],
    ["Array.of(1, 2).length + String.fromCharCode(65)", "2A"],
    ["new Promise((resolve) => resolve(1)) instanceof Promise", "true"],
    ["new (class P extends Promise {})(() => {}) instanceof Promise", "true"],
    ["Promise.resolve(1).constructor === Promise", "true"],
    ["typeof Promise.try", "undefined"],
    ["JSON.stringify(new String('a\\u0001'))", '"a\\u0001"'],
    ["JSON.stringify({ ['k' + String.fromCharCode(10)]: 'x'.repeat(100) }).length", "110"],
    ["JSON.stringify(String.fromCharCode(0xd800))", '"\\ud800"'],
    ["'abc'.replace('b', '[$`|$&|$\\']')", "a[a|b|c]c"],
    ["'a-b-c'.replace(/(\\w)-/g, '$1+')", "a+b+c"],
    ["'abc'.replace(/b/, (m, i) => m.toUpperCase() + i)", "aB1c"],
    ["'abab'.replaceAll('b', () => 1)", "a1a1"],
    [
      "'1.5'.replace(1.5, 'x') + 'n'.replace(null, 'y') + 'undefined'.replace(undefined, 'z')",
      "xnz",
    ],
    [
      "'a,b,c'.split(',', 2).join() + 'ab'.split().length + 'ab'.split(undefined, 0).length",
      "a,b10",
    ],
    ["'aXbX'.split(/x/i).join('|')", "a|b|"],
    ["String('ab'.match(undefined)[0].length) + 'a.b'.search('.')", "00"],
    ["[...'a1b2'.matchAll(/\\d/g)].map((m) => m[0]).join()", "1,2"],
    ["/b/g[Symbol.replace]('abcb', '-')", "a-c-"],
    ["new (class R extends RegExp {})('b', 'g')[Symbol.split]('abc').join()", "a,c"],
    ["'ÄB'.toLowerCase() + 'ß'.toUpperCase() + 'e\\u0301'.normalize('NFC').length", "äbSS1"],
    ["'a'.localeCompare('b') + 'b'.localeCompare('a')", "0"],
    ["[...'héllo'].length + Array.from('ab').join('')", "5ab"],
    ["[...new Map([[1, 2]])].join() + [...new Set([3]).entries()].join()", "1,23,3"],
    ["(() => { let n = 0; new Map([[1, 2]]).forEach((v) => { n += v; }); return n; })()", "2"],
    ["escape('é') + unescape('%E9') + decodeURIComponent('%C3%A9')", "%E9éé"],
    [
      "(() => { let e; new Promise(() => { throw 7; }).catch((x) => { e = x; }); return typeof e; })()",
      "undefined",
    ],
  ];
  for (const [expr, expected] of cases) {
    it(expr, () => {
      expect(evaluate(expr)).toBe(expected);
    });
  }
});
