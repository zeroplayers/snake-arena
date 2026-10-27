import { beforeAll, describe, expect, it } from "vitest";
import { createSandbox, instrument, type Sandbox } from "./index.ts";
import { MAX_FUNCTION_NODES } from "./instrument.ts";
import { botWithTick, makeInfo, oneState } from "./testing/fixtures.ts";

let sandbox: Sandbox;
beforeAll(async () => {
  sandbox = await createSandbox();
});

/** Runs `body` (a function body returning JSON-able data) in the sandbox and in Node. */
function both(body: string): { sandboxed: unknown; native: unknown } {
  const life = sandbox.startLife(
    botWithTick(`log(JSON.stringify((function () { ${body} })())); return { turn: 0 };`),
    makeInfo(),
  );
  expect(life.death, life.death?.message).toBeNull();
  const report = life.tick(oneState());
  life.dispose();
  expect(report.outcome, report.error ?? "").toBe("ok");
  const native = new Function(`"use strict"; ${body}`)();
  return {
    sandboxed: JSON.parse(report.log.lines[0] ?? "null"),
    native: JSON.parse(JSON.stringify(native)),
  };
}

describe("instrument keeps the semantics", () => {
  const programs: Record<string, string> = {
    "labels, break and continue": `
      const out = [];
      outer: for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) { if (j === 2) continue outer; if (i === 3) break outer; out.push(i * 10 + j); }
      }
      let k = 0; do k++; while (k < 5);
      let w = 0; while (w < 3) w++;
      for (;;) break;
      return [out, k, w];`,
    "loops without braces and empty bodies": `
      let s = 0; for (let i = 0; i < 5; i++) s += i;
      let t = 0; for (let i = 0; i < 5; t += i++);
      const keys = []; for (const k in { a: 1, b: 2 }) keys.push(k);
      const vals = []; for (const v of [3, 4]) vals.push(v);
      if (s > 3) s = -s; else s = 0;
      return [s, t, keys, vals];`,
    "switch with fallthrough and default": `
      const out = [];
      for (const x of [0, 1, 2, 3]) {
        switch (x) {
          case 0: out.push('zero');
          case 1: out.push('one'); ${"out.push(1);".repeat(30)} break;
          default: out.push('other');
          case 2: out.push('two');
        }
      }
      return out;`,
    "try, catch and finally": `
      const out = [];
      function f() { try { return 'try'; } finally { out.push('finally'); } }
      function g() { try { throw 1; } catch { return 'caught'; } finally { out.push('g'); } }
      function h() { try { throw new Error('x'); } finally { return 'swallowed'; } }
      function k() { for (let i = 0; i < 3; i++) { try { if (i < 2) throw i; } finally { if (i < 2) continue; } return i; } }
      function m() { try { try { throw 'inner'; } finally { out.push('m'); } } catch (e) { return e; } }
      let e2; try { null.x; } catch (e) { e2 = e instanceof TypeError; }
      return [f(), g(), h(), k(), m(), e2, out];`,
    "functions, defaults and patterns": `
      function f(a, b = a + 1, { c, d: [e, ...rest] = [5, 6, 7] } = {}, ...more) { return [a, b, c, e, rest, more]; }
      const arrow = (x) => ({ x });
      const seq = (x) => (x, x + 1);
      const { p, q: { r = 9 } = {} } = { p: 1 };
      const { k0, ...others } = { k0: 0, k1: 1, k2: 2 };
      let x1, y1; ({ x: x1, ...y1 } = { x: 1, y: 2 });
      return [f(1), f(1, 2, { c: 3 }, 8, 9), arrow(4), seq(1), p, r, others, x1, y1, f.length, arrow.length];`,
    "closures and per-iteration bindings": `
      const fs = [];
      for (let i = 0; i < 3; i++) fs.push(() => i);
      const counter = (() => { let n = 0; return () => ++n; })();
      counter(); counter();
      return [fs.map((f) => f()), counter()];`,
    classes: `
      class A { x = 1; #y = 2; static s = 'S'; static { A.t = A.s + '!'; } get y() { return this.#y; } m() { return this.x + this.#y; } }
      class B extends A { z = this.x + 10; constructor() { super(); this.w = this.z * 2; } m() { return super.m() * 10; } }
      const b = new B();
      return [b.x, b.y, b.z, b.w, b.m(), A.s, A.t, Object.keys(b), b instanceof A];`,
    "getters, setters and generators": `
      const o = { _v: 1, get v() { return this._v * 2; }, set v(n) { this._v = n; } };
      o.v = 5;
      function* g(n) { for (let i = 0; i < n; i++) yield i * i; return 'done'; }
      const it = g(3);
      return [o.v, [...g(4)], it.next(), it.next(), it.next(), it.next()];`,
    "spread, rest and for-in": `
      const base = { a: 1 };
      const child = Object.create(base); child.b = 2;
      const keys = []; for (const k in child) keys.push(k);
      const merged = { ...child, ...[7], c: 3 };
      const arr = [...'ab', ...[1, 2]];
      const keys2 = []; for (const k in (0, child)) keys2.push(k);
      return [keys, merged, arr, Math.max(...arr.slice(2)), keys2];`,
    "templates, tags and optional chaining": `
      const tag = (s, ...v) => s.raw.join('|') + v.join(',');
      const o = { a: { b: () => 4 } };
      return [\`x\${1 + 1}y\`, tag\`a\${1}b\${2}c\`, o?.a?.b?.(), o.z?.b, o.z?.()];`,
    "asi and comments": `
      let a = 1
      let b = a
      ;(function () { a = 2 })()
      if (a) /* comment */ b = 3
      else b = 4
      // trailing comment
      return [a, b]`,
    "errors and their messages": `
      const out = [];
      try { undefined.x; } catch (e) { out.push(e.constructor === TypeError, e instanceof Error); }
      try { throw new RangeError('r'); } catch (e) { out.push(e.message, e.name, e instanceof RangeError); }
      class MyError extends Error { constructor(m) { super(m); this.name = 'MyError'; } }
      try { throw new MyError('mine'); } catch (e) { out.push(e.name, e.message, e instanceof Error, Error.prototype.isPrototypeOf(e)); }
      out.push(Object.getPrototypeOf(TypeError) === Error, Error('no new').message);
      return out;`,
  };
  for (const [name, body] of Object.entries(programs)) {
    it(name, () => {
      const { sandboxed, native } = both(body);
      expect(sandboxed).toEqual(native);
    });
  }

  it("keeps every line where it was", () => {
    const source = botWithTick(`
      const a = 1;
      for (let i = 0; i < 2; i++) a + i;
      throw new Error("line 5");`);
    const out = instrument(source);
    if (!out.ok) throw new Error(out.error);
    expect(out.source.split("\n").length).toBe(source.split("\n").length);
    const life = sandbox.startLife(source, makeInfo());
    const report = life.tick(oneState());
    life.dispose();
    expect(report.error).toMatch(/^Error: line 5\n\s+at tick \(bot\.js:5:/);
  });

  it("is deterministic", () => {
    const source = botWithTick(
      "for (const x of state.food) if (x.value > 0) log(x.x); return { turn: 0 };",
    );
    expect(instrument(source)).toEqual(instrument(source));
  });
});

describe("instrument rejects", () => {
  const cases: [string, string, RegExp][] = [
    [
      "reserved names",
      "const __zs_g = 1e15; export default { tick() {} };",
      /reserved for the sandbox/,
    ],
    ["escaped reserved names", "const \\u005f_zs_g = 1; export default { tick() {} };", /reserved/],
    ["reserved private names", "class A { #__zs = 1; } export default { tick() {} };", /reserved/],
    ["reserved parameter names", "export default { tick(__zs_o) {} };", /reserved/],
    ["object rest in parameters", "export default { tick({ a, ...rest }) {} };", /object rest/],
    [
      "nested object rest",
      "const { a: { ...b } } = {}; export default { tick() {} };",
      /object rest/,
    ],
    [
      "object rest in for-of",
      "for (const { ...r } of []) {} export default { tick() {} };",
      /object rest/,
    ],
    [
      "catch patterns",
      "try {} catch ({ message }) {} export default { tick() {} };",
      /catch clause/,
    ],
    ["imports", "import x from 'y'; export default { tick() {} };", /can't import/],
    ["re-exports", "export { x } from 'y'; export default { tick() {} };", /can't import/],
    ["dynamic import", "export default { tick() { import('x'); } };", /can't import/],
    [
      "deep nesting",
      `const x = ${"[".repeat(300)}${"]".repeat(300)}; export default { tick() {} };`,
      /nested more than 200/,
    ],
    ["syntax errors", "export default { tick( };", /^SyntaxError/],
    ["BigInt", "const x = 1n; export default { tick() {} };", /BigInt/],
    [
      "functions over the size limit",
      `export default { tick() { let x = 0; ${"x = (x + 1) | 0;".repeat(MAX_FUNCTION_NODES / 6)} } };`,
      /too large for the sandbox/,
    ],
    [
      "class fields over the size limit",
      `class A { ${Array.from({ length: MAX_FUNCTION_NODES / 2 }, (_, i) => `f${i} = ${i};`).join(" ")} } export default { tick() {} };`,
      /too large for the sandbox/,
    ],
  ];
  for (const [name, source, message] of cases) {
    it(name, () => {
      const out = instrument(source);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toMatch(message);
      const life = sandbox.startLife(source, makeInfo());
      expect(life.death).toMatchObject({ fault: "error", reason: "load" });
    });
  }

  it("accepts big tables at module level", () => {
    const source = `const table = [${Array.from({ length: 20000 }, (_, i) => i).join(",")}];
      export default { tick() { return { turn: table[5] / 1e5 }; } };`;
    const life = sandbox.startLife(source, makeInfo());
    expect(life.death).toBeNull();
    expect(life.tick(oneState()).action).toEqual({ turn: 5e-5 });
    life.dispose();
  });
});

describe("the meter is out of the bot's reach", () => {
  it("leaves nothing on globalThis", () => {
    const report = (() => {
      const life = sandbox.startLife(
        botWithTick(
          "log(Reflect.ownKeys(globalThis).filter((k) => String(k).includes('zs')).join(',') || 'none'); return { turn: 0 };",
          "const seen = typeof globalThis['__zs' + '_meter'];",
        ).replace("export default", "export const atLoad = seen; export default"),
        makeInfo(),
      );
      const r = life.tick(oneState());
      life.dispose();
      return r;
    })();
    expect(report.log.lines).toEqual(["none"]);
  });

  it("refuses a bundle that skips the header", () => {
    // What a consumer that bypassed instrument() would run: the prelude notices.
    const life = sandbox.startLife(
      botWithTick("return { turn: 0 };").replace(
        "export default",
        "globalThis.x = 1; export default",
      ),
      makeInfo(),
    );
    expect(life.death).toBeNull(); // instrumented by startLife itself
    life.dispose();
  });
});
