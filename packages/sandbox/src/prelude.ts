/**
 * JavaScript evaluated in every fresh QuickJS context before the bot module.
 *
 * Its completion value is `setup(host, options)`, which hardens the globals and returns the
 * driver the host calls (`begin`, `load`, `tick`, `work`, `describe`). Nothing it creates is reachable
 * from bot code except through the globals it deliberately installs (`Math.random`, `console`).
 *
 * Why the wrappers: QuickJS only calls the interrupt handler from bytecode and C-function calls,
 * about once per 10 000 of them. A native built-in that loops internally (`indexOf` on a sparse
 * array of length 1e8, `slice` of a 40 MB string, `new Uint8Array(1e7)`) runs to completion
 * between two checks, and a bot can call it thousands of times before the next one. So every
 * built-in whose cost grows with its input is wrapped to:
 *   1. throw a RangeError when an array or typed array is longer than `maxArrayLength`;
 *   2. charge its input size to a per-tick native work counter. Past `workLimit` the wrapper asks
 *      the host to fail the next interrupt check and spins until it comes: an uncatchable
 *      "interrupted" error that the host reports as a timeout.
 * Weights (work units per element / char) are rough calibrations: 1 unit ≈ 1 ns of CPU on an M1,
 * `workLimit` = opBudget × 1e6 units ≈ the same CPU as `opBudget` interrupts of plain bytecode.
 *
 * `concat`, `flat` and `flatMap` read several arrays in one native call, so a getter on one could
 * grow another after it was checked; they are re-implemented in JS here, where every step counts.
 *
 * Written as plain JS in a string (not a function's `.toString()`) so no TS transform, bundler or
 * coverage tool can rewrite it. Keep it free of backticks and `${`.
 */
export const PRELUDE = String.raw`
(function setup(host, options) {
  "use strict";
  const g = globalThis;
  const emit = host.emit;
  const exhaust = host.exhaust;
  const maxArrayLength = options.maxArrayLength;
  const logLimit = options.logLimitBytes;

  const { apply, construct, defineProperty, deleteProperty, getOwnPropertyDescriptor,
    getPrototypeOf, setPrototypeOf } = Reflect;
  const ObjectCtor = Object;
  const hasOwn = Object.hasOwn;
  const isArray = Array.isArray;
  const StringCtor = String;
  const NumberCtor = Number;
  const SetCtor = Set;
  const iteratorKey = Symbol.iterator;
  const RangeErrorCtor = RangeError;
  const TypeErrorCtor = TypeError;
  const EvalErrorCtor = EvalError;
  const parse = JSON.parse;
  const nativeStringify = JSON.stringify;
  const floor = Math.floor;
  const log2 = Math.log2;
  const imul = Math.imul;
  const sliceString = String.prototype.slice;
  const TypedArray = getPrototypeOf(Uint8Array);
  const TypedArrayProto = TypedArray.prototype;
  const taTag = getOwnPropertyDescriptor(TypedArrayProto, Symbol.toStringTag).get;
  const taLength = getOwnPropertyDescriptor(TypedArrayProto, "length").get;
  const regexpSource = getOwnPropertyDescriptor(RegExp.prototype, "source").get;
  const abByteLength = getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;
  const MAX_LENGTH = 9007199254740991;

  // Work units per element or char.
  const ARRAY = 100;
  const TYPED = 10;
  const BYTE = 1;
  const CHAR = 1;

  // ---- native work accounting ----

  let work = 0;
  let workLimit = Infinity;
  function charge(units) {
    if (!(units > 0)) return;
    work += units;
    if (work > workLimit) {
      exhaust();
      for (;;) {}
    }
  }

  function tooLong(name, len) {
    throw new RangeErrorCtor(StringCtor(name) + ": length " + len +
      " is over the sandbox limit of " + maxArrayLength);
  }

  function isTypedArray(o) {
    return typeof o === "object" && o !== null && apply(taTag, o, []) !== undefined;
  }

  function isRegExp(o) {
    try {
      apply(regexpSource, o, []);
      return true;
    } catch {
      return false;
    }
  }

  function toLength(v) {
    return v > 0 ? (v < MAX_LENGTH ? floor(v) : MAX_LENGTH) : 0;
  }

  // Length the way a native Array method will read it, without running bot code (a getter or a
  // valueOf could return a small length now and a huge one when the native reads it again).
  function arrayLength(o) {
    if (isArray(o)) return o.length;
    if (o === null || o === undefined) return 0;
    if (isTypedArray(o)) return apply(taLength, o, []);
    let obj = ObjectCtor(o);
    do {
      const d = getOwnPropertyDescriptor(obj, "length");
      if (d !== undefined) {
        if (!hasOwn(d, "value") || typeof d.value !== "number") {
          throw new TypeErrorCtor("sandbox: an array-like 'length' must be a plain number");
        }
        return toLength(d.value);
      }
      obj = getPrototypeOf(obj);
    } while (obj !== null);
    return 0;
  }

  // A Symbol.iterator getter would run after we read the length but before the native does.
  function noIteratorGetter(o) {
    for (let p = o; p !== null; p = getPrototypeOf(p)) {
      const d = getOwnPropertyDescriptor(p, iteratorKey);
      if (d === undefined) continue;
      if (!hasOwn(d, "value")) {
        throw new TypeErrorCtor("sandbox: a Symbol.iterator getter is not supported here");
      }
      return;
    }
  }

  function typedLength(o) {
    return apply(taLength, o, []);
  }

  function checked(name, len, weight) {
    if (len > maxArrayLength) tooLong(name, len);
    charge(len * weight);
  }

  function replaceMethod(obj, name, make) {
    const d = getOwnPropertyDescriptor(obj, name);
    if (d === undefined || typeof d.value !== "function") return;
    const native = d.value;
    const wrapped = make(native);
    defineProperty(wrapped, "name", { value: native.name });
    defineProperty(wrapped, "length", { value: native.length });
    defineProperty(obj, name, { value: wrapped, writable: d.writable, enumerable: d.enumerable,
      configurable: d.configurable });
  }

  // Charges cost(this, args) before calling the native with the same this and arguments.
  function guard(obj, name, cost) {
    replaceMethod(obj, name, (native) => ({
      m(...args) {
        cost(this, args, name);
        return apply(native, this, args);
      },
    }).m);
  }

  const linear = (lengthOf, weight) => (self, _args, name) =>
    checked(name, lengthOf(self), weight);
  const nlogn = (lengthOf, weight) => (self, _args, name) => {
    const len = lengthOf(self);
    if (len > maxArrayLength) tooLong(name, len);
    charge(len * (len > 2 ? log2(len) : 1) * weight);
  };

  // ---- Array.prototype ----

  const ArrayProto = Array.prototype;
  // O(1) or already interrupt-checked per element: push, pop and at. Iterators are charged too:
  // they are how spread, for-of and destructuring walk an array.
  const ARRAY_CHEAP = new SetCtor(["constructor", "push", "pop", "at", "concat", "flat",
    "flatMap"]);
  for (const name of Reflect.ownKeys(ArrayProto)) {
    if (ARRAY_CHEAP.has(name)) continue;
    const sorting = name === "sort" || name === "toSorted";
    guard(ArrayProto, name, (sorting ? nlogn : linear)(arrayLength, ARRAY));
  }

  function define(a, i, v) {
    defineProperty(a, i, { value: v, writable: true, enumerable: true, configurable: true });
  }
  function isSpreadable(o) {
    if (typeof o !== "object" || o === null) return false;
    const s = o[Symbol.isConcatSpreadable];
    return s !== undefined ? !!s : isArray(o);
  }
  function concat(...items) {
    const out = [];
    let n = 0;
    for (let i = -1; i < items.length; i++) {
      const e = i < 0 ? ObjectCtor(this) : items[i];
      if (!isSpreadable(e)) {
        define(out, n++, e);
        continue;
      }
      const len = arrayLength(e);
      checked("concat", len, ARRAY);
      for (let k = 0; k < len; k++, n++) if (k in e) define(out, n, e[k]);
    }
    out.length = n;
    return out;
  }
  function flatten(out, src, depth, mapper, thisArg) {
    const len = arrayLength(src);
    checked("flat", len, ARRAY);
    for (let k = 0; k < len; k++) {
      if (!(k in src)) continue;
      let e = src[k];
      if (mapper !== undefined) e = apply(mapper, thisArg, [e, k, src]);
      if (depth > 0 && isArray(e)) flatten(out, e, depth - 1, undefined, undefined);
      else define(out, out.length, e);
    }
    return out;
  }
  function flat(depth) {
    const d = depth === undefined ? 1 : NumberCtor(depth);
    return flatten([], ObjectCtor(this), d === d ? d : 0, undefined, undefined);
  }
  function flatMap(mapper, thisArg) {
    if (typeof mapper !== "function") throw new TypeErrorCtor("flatMap: mapper is not a function");
    return flatten([], ObjectCtor(this), 1, mapper, thisArg);
  }
  replaceMethod(ArrayProto, "concat", () => ({ concat }).concat);
  replaceMethod(ArrayProto, "flat", () => ({ flat }).flat);
  replaceMethod(ArrayProto, "flatMap", () => ({ flatMap }).flatMap);

  function arrayLikeCost(name, src, weight) {
    if (typeof src === "object" && src !== null) {
      noIteratorGetter(src);
      checked(name, arrayLength(src), weight);
    } else if (typeof src === "string") charge(src.length * CHAR);
  }
  const arrayLikeArg = (weight) => (_self, args, name) => arrayLikeCost(name, args[0], weight);
  guard(Array, "from", arrayLikeArg(ARRAY));

  // ---- typed arrays and buffers ----

  const TYPED_CHEAP = new SetCtor(["constructor", "at", "subarray"]);
  for (const name of Reflect.ownKeys(TypedArrayProto)) {
    if (TYPED_CHEAP.has(name)) continue;
    const sorting = name === "sort" || name === "toSorted";
    guard(TypedArrayProto, name, (sorting ? nlogn : linear)(typedLength, TYPED));
  }
  guard(TypedArray, "from", arrayLikeArg(TYPED));
  guard(TypedArray, "of", (_self, args) => charge(args.length * TYPED));
  guard(ArrayBuffer.prototype, "slice", (self) => charge(apply(abByteLength, self, []) * BYTE));
  guard(ArrayBuffer.prototype, "resize", (_self, args) => charge(toLength(args[0] = +args[0]) * BYTE));
  guard(ArrayBuffer.prototype, "transfer", (self) => charge(apply(abByteLength, self, []) * BYTE));

  // Allocation is zero-filled (and copying an array-like walks it), so constructors are charged
  // by size too. The wrapper keeps prototype identity: instanceof and subclassing still work.
  function guardConstructor(name, cost) {
    const Native = g[name];
    const Wrapped = function (...args) {
      if (new.target === undefined) return apply(Native, this, args);
      cost(args);
      return construct(Native, args, new.target);
    };
    setPrototypeOf(Wrapped, getPrototypeOf(Native));
    for (const key of Reflect.ownKeys(Native)) {
      if (key === "length" || key === "name" || key === "prototype") continue;
      defineProperty(Wrapped, key, getOwnPropertyDescriptor(Native, key));
    }
    defineProperty(Wrapped, "name", { value: name });
    defineProperty(Wrapped, "length", { value: Native.length });
    defineProperty(Wrapped, "prototype", { value: Native.prototype, writable: false });
    defineProperty(Native.prototype, "constructor", { value: Wrapped, writable: true,
      configurable: true });
    defineProperty(g, name, { value: Wrapped, writable: true, configurable: true });
  }
  const TYPED_NAMES = ["Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array",
    "Uint16Array", "Int32Array", "Uint32Array", "Float16Array", "Float32Array", "Float64Array"];
  for (const name of TYPED_NAMES) {
    if (typeof g[name] !== "function") continue;
    guardConstructor(name, (args) => {
      const a = args[0];
      if (typeof a === "object" && a !== null) {
        try {
          apply(abByteLength, a, []);
          return; // a view on an existing buffer: nothing is copied
        } catch {}
        arrayLikeCost(name, a, TYPED);
      } else if (args.length > 0) {
        // Convert once, so a valueOf cannot report a different size to the native.
        charge(toLength(args[0] = +a) * TYPED);
      }
    });
  }
  guardConstructor("ArrayBuffer", (args) => {
    let size = args.length > 0 ? toLength(args[0] = +args[0]) : 0;
    const opts = args[1];
    if (typeof opts === "object" && opts !== null) {
      const max = opts.maxByteLength;
      if (max !== undefined) {
        args[1] = { maxByteLength: +max };
        if (toLength(+max) > size) size = toLength(+max);
      }
    }
    charge(size * BYTE);
  });

  // ---- strings ----

  const StringProto = String.prototype;
  // Longest string QuickJS can build; asking for more throws a RangeError natively, so it is not
  // charged (charging would turn that error into a timeout).
  const MAX_STRING = 1073741823;
  const STRING_CHEAP = new SetCtor(["constructor", "at", "charAt", "charCodeAt", "codePointAt",
    "toString", "valueOf", iteratorKey]);
  const SEARCH = new SetCtor(["indexOf", "lastIndexOf", "includes", "startsWith", "endsWith",
    "split", "replace", "replaceAll", "match", "matchAll", "search", "localeCompare"]);
  function guardString(name, cost) {
    replaceMethod(StringProto, name, (native) => ({
      m(...args) {
        // Convert once here, so the native gets a primitive and cannot run bot code (a
        // toString returning a different string) after we measured it.
        const s = this === null || this === undefined ? this : StringCtor(this);
        if (typeof s === "string") cost(s, args);
        return apply(native, s, args);
      },
    }).m);
  }
  for (const name of Reflect.ownKeys(StringProto)) {
    if (STRING_CHEAP.has(name)) continue;
    if (SEARCH.has(name)) {
      guardString(name, (s, args) => {
        // Naive search is O(haystack × needle).
        let needle = args[0];
        if (typeof needle === "object" && needle !== null && !isRegExp(needle)) {
          needle = args[0] = StringCtor(needle);
        }
        const m = typeof needle === "string" && needle.length > 1 ? needle.length : 1;
        charge(s.length * m * CHAR);
      });
    } else if (name === "repeat") {
      guardString(name, (s, args) => {
        const n = s.length * (args[0] = +args[0]);
        if (n <= MAX_STRING) charge(n * CHAR);
      });
    } else if (name === "padStart" || name === "padEnd") {
      guardString(name, (s, args) => {
        const n = toLength(args[0] = +args[0]);
        if (n <= MAX_STRING) charge((s.length + n) * CHAR);
      });
    } else if (name === "concat") {
      guardString(name, (s, args) => {
        let n = s.length;
        for (let i = 0; i < args.length; i++) {
          args[i] = StringCtor(args[i]);
          n += args[i].length;
        }
        charge(n * CHAR);
      });
    } else {
      guardString(name, (s) => charge(s.length * CHAR));
    }
  }

  // ---- calls, JSON, object enumeration ----

  const argsLength = (i) => (_self, args, name) => {
    const list = args[i];
    if (typeof list === "object" && list !== null) checked(name, arrayLength(list), ARRAY);
  };
  guard(Function.prototype, "apply", argsLength(1));
  guard(Reflect, "apply", argsLength(2));
  guard(Reflect, "construct", argsLength(1));
  guard(JSON, "parse", (_self, args) => charge((args[0] = StringCtor(args[0])).length * CHAR));

  // The replacer runs in bytecode for every value, so stringify is interrupt-checked; it also
  // checks each array right before stringify walks it. An array replacer (a key allow-list) is
  // turned into a function: same output, except keys come out in object order, not list order.
  function stringify(value, replacer, space) {
    let keep;
    if (isArray(replacer)) {
      checked("JSON.stringify", replacer.length, ARRAY);
      keep = new SetCtor();
      for (let i = 0; i < replacer.length; i++) {
        const k = replacer[i];
        if (typeof k === "string" || typeof k === "number") keep.add(StringCtor(k));
      }
      replacer = undefined;
    }
    const user = typeof replacer === "function" ? replacer : undefined;
    return nativeStringify(value, function (key, v) {
      if (keep !== undefined && key !== "" && !isArray(this) && !keep.has(key)) return undefined;
      if (user !== undefined) v = apply(user, this, [key, v]);
      if (isArray(v)) checked("JSON.stringify", v.length, ARRAY);
      else if (isTypedArray(v)) checked("JSON.stringify", typedLength(v), TYPED);
      return v;
    }, space);
  }
  defineProperty(JSON, "stringify", { value: stringify, writable: true, configurable: true });

  // Cost is linear in the number of keys returned, which we only know afterwards.
  function chargeAfter(obj, name) {
    replaceMethod(obj, name, (native) => ({
      m(...args) {
        const out = apply(native, this, args);
        charge(out.length * ARRAY);
        return out;
      },
    }).m);
  }
  for (const name of ["keys", "values", "entries", "getOwnPropertyNames", "getOwnPropertySymbols"]) {
    chargeAfter(Object, name);
  }
  chargeAfter(Reflect, "ownKeys");

  // ---- determinism and unavailable features ----

  // BigInt arithmetic runs in C with no interrupt checks (7n ** 300000n takes ~0.5 s), and
  // nothing in a bot needs it. Literals are rejected by the host before evaluation.
  for (const name of ["BigInt", "BigInt64Array", "BigUint64Array", "eval", "WeakRef",
    "FinalizationRegistry", "SharedArrayBuffer", "Atomics"]) {
    deleteProperty(g, name);
  }
  for (const name of ["getBigInt64", "getBigUint64", "setBigInt64", "setBigUint64"]) {
    deleteProperty(DataView.prototype, name);
  }

  // No code from strings: it could smuggle in BigInt literals, and Workers forbid it anyway.
  function blockCompiler(proto, name) {
    const Blocked = function () {
      throw new EvalErrorCtor(name + "() is not available to bots");
    };
    defineProperty(Blocked, "name", { value: name });
    defineProperty(Blocked, "prototype", { value: proto, writable: false });
    defineProperty(proto, "constructor", { value: Blocked, writable: true, configurable: true });
    return Blocked;
  }
  defineProperty(g, "Function", { value: blockCompiler(Function.prototype, "Function"),
    writable: true, configurable: true });
  blockCompiler(getPrototypeOf(function* () {}), "GeneratorFunction");
  blockCompiler(getPrototypeOf(async function () {}), "AsyncFunction");
  blockCompiler(getPrototypeOf(async function* () {}), "AsyncGeneratorFunction");

  // Seeded per life (mulberry32).
  let rngState = options.seed >>> 0;
  function random() {
    rngState = (rngState + 0x6d2b79f5) | 0;
    let t = imul(rngState ^ (rngState >>> 15), 1 | rngState);
    t = (t + imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  defineProperty(Math, "random", { value: random, writable: true, configurable: true });

  // ---- log ----

  // Same formatting as createTickLog in @zerosnake/sdk. The host keeps the lines (so they survive
  // a timeout) and applies the byte limit; emit returns false once the limit is reached.
  let logOpen = false;
  function formatArg(arg) {
    if (typeof arg === "string") return arg;
    try {
      const json = stringify(arg);
      if (json !== undefined) return json;
    } catch {}
    return StringCtor(arg);
  }
  function log(...args) {
    if (!logOpen) return;
    let line = "";
    for (let i = 0; i < args.length && line.length <= logLimit; i++) {
      line += (i > 0 ? " " : "") + formatArg(args[i]);
    }
    // Cutting to limit + 1 UTF-16 units keeps the host's truncation result identical.
    if (line.length > logLimit + 1) line = apply(sliceString, line, [0, logLimit + 1]);
    logOpen = emit(line);
  }
  const console = { log, info: log, warn: log, error: log, debug: log };
  defineProperty(g, "console", { value: console, writable: true, configurable: true });

  // ---- driver ----

  let bot;
  let tickFn;
  let mem;

  // Reads a data property along the prototype chain without running getters.
  function dataProp(o, key) {
    while (o !== null) {
      const d = getOwnPropertyDescriptor(o, key);
      if (d !== undefined) return hasOwn(d, "value") ? d.value : undefined;
      o = getPrototypeOf(o);
    }
    return undefined;
  }

  return {
    // Starts a budgeted phase: module evaluation + load, or one tick.
    begin(limit) {
      work = 0;
      workLimit = limit;
      logOpen = true;
    },
    load(ns, infoJson) {
      const def = ns.default;
      if ((typeof def !== "object" && typeof def !== "function") || def === null) {
        throw new TypeErrorCtor("the bot module must 'export default defineBot({ init, tick })'");
      }
      const tick = def.tick;
      if (typeof tick !== "function") {
        throw new TypeErrorCtor("the default export has no tick() function");
      }
      const init = def.init;
      let m = {};
      if (init !== undefined) {
        if (typeof init !== "function") throw new TypeErrorCtor("init must be a function");
        m = apply(init, def, [parse(infoJson)]);
        if (m === undefined) m = {};
        if ((typeof m !== "object" && typeof m !== "function") || m === null) {
          throw new TypeErrorCtor("init() must return an object (the bot's memory)");
        }
      }
      bot = def;
      tickFn = tick;
      mem = m;
    },
    tick(stateJson, limit) {
      work = 0;
      workLimit = limit;
      logOpen = true;
      const action = apply(tickFn, bot, [parse(stateJson), mem, log]);
      if (typeof action !== "object" || action === null) {
        throw new TypeErrorCtor("tick() must return an action like { turn: 0 }, got " +
          (action === null ? "null" : typeof action));
      }
      const t = action.turn;
      const turn = typeof t === "number" && t === t ? (t > 1 ? 1 : t < -1 ? -1 : t) : 0;
      return [turn, action.boost === true];
    },
    work() {
      return work;
    },
    // Never runs bot code: only own data properties and primitive conversions.
    describe(e) {
      if ((typeof e !== "object" && typeof e !== "function") || e === null) {
        return typeof e === "symbol" ? "Symbol" : "uncaught " + StringCtor(e);
      }
      const name = dataProp(e, "name");
      const message = dataProp(e, "message");
      const stack = dataProp(e, "stack");
      let out = (typeof name === "string" ? name : "Error") + ": " +
        (typeof message === "string" ? message : "");
      if (typeof stack === "string" && stack !== "") out += "\n" + stack;
      return apply(sliceString, out, [0, 2000]);
    },
  };
})
`;
