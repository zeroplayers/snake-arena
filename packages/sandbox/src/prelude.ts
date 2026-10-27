/**
 * JavaScript evaluated in every fresh QuickJS context before the bot module.
 *
 * Its completion value is `setup(host, options)`, which hardens the globals and returns the
 * driver the host calls (`begin`, `load`, `tick`, `work`, `describe`). Nothing it creates is reachable
 * from bot code except through the globals it deliberately installs (`Math.random`, `console`) and
 * the meter helpers it hands to the instrumented bundle's header (see `instrument.ts`).
 *
 * Why the wrappers: QuickJS only calls the interrupt handler from bytecode and C-function calls,
 * about once per 10 000 of them. A native built-in that loops internally (`indexOf` on a sparse
 * array of length 1e8, `slice` of a 40 MB string, `new Uint8Array(1e7)`) runs to completion
 * between two checks, and a bot can call it thousands of times before the next one. So every
 * built-in whose cost grows with its input is wrapped to:
 *   1. throw a RangeError when an array or typed array is longer than `maxArrayLength`;
 *   2. charge its input size to the per-tick cost meter, the same one the instrumented bot code
 *      charges for its own bytecode. When it runs out, the host fails every later interrupt check
 *      (an uncatchable "interrupted" error, reported as a timeout) and a sentinel is thrown that
 *      no catch in bot code can keep (see `overrun`).
 * Weights (units per element / char) are rough calibrations: 1 unit ≈ 1 ns of CPU on an M1, and
 * a tick gets opBudget × 1e6 units.
 *
 * `concat`, `flat` and `flatMap` read several arrays in one native call, so a getter on one could
 * grow another after it was checked; they are re-implemented in JS here, where every step counts.
 *
 * Strings: every built-in that builds a string throws a RangeError above `maxStringLength`, and
 * every built-in that converts, hashes or compares strings the bot stored earlier (a native used
 * as a callback, the elements of an iterable or array it reads, `valueOf` of a String object, a
 * regex's `lastIndex`) charges their length here; the instrumented code charges the rest (see
 * `instrument.ts`).
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
  const maxString = options.maxStringLength;
  const logLimit = options.logLimitBytes;

  const { apply, construct, defineProperty, deleteProperty, getOwnPropertyDescriptor,
    getPrototypeOf, setPrototypeOf } = Reflect;
  const ownKeysNative = Reflect.ownKeys;
  const ObjectCtor = Object;
  const hasOwn = Object.hasOwn;
  const isArray = Array.isArray;
  const StringCtor = String;
  const NumberCtor = Number;
  const SetCtor = Set;
  const WeakSetCtor = WeakSet;
  const weakSetAdd = WeakSet.prototype.add;
  const weakSetHas = WeakSet.prototype.has;
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
  const indexOfString = String.prototype.indexOf;
  const stringValueOf = String.prototype.valueOf;
  const regexpExec = RegExp.prototype.exec;
  const bindNative = Function.prototype.bind;
  const regexpGlobal = getOwnPropertyDescriptor(RegExp.prototype, "global").get;
  const regexpFlags = getOwnPropertyDescriptor(RegExp.prototype, "flags").get;
  const speciesKey = Symbol.species;
  const regexpSpecies = getOwnPropertyDescriptor(RegExp, speciesKey).get;
  const TypedArray = getPrototypeOf(Uint8Array);
  const TypedArrayProto = TypedArray.prototype;
  const taTag = getOwnPropertyDescriptor(TypedArrayProto, Symbol.toStringTag).get;
  const taLength = getOwnPropertyDescriptor(TypedArrayProto, "length").get;
  const regexpSource = getOwnPropertyDescriptor(RegExp.prototype, "source").get;
  const objectToString = Object.prototype.toString;
  const numberValueOf = Number.prototype.valueOf;
  const toStringTagKey = Symbol.toStringTag;
  const abByteLength = getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;
  const MAX_LENGTH = 9007199254740991;

  // Work units per element or char.
  const ARRAY = 100;
  const TYPED = 10;
  const BYTE = 1;
  const CHAR = 1;
  // Building a fresh object or array per key (descriptors, entries).
  const OBJECT = 500;
  // String built-ins that do more than copy, per char of input (measured worst case in ns:
  // case mapping 18, normalize 108, URI encoding and escape 43, number parsing 12, URI decoding
  // 5, JSON.parse 7, JSON.stringify 8 plus 18 to scan a long string for chars it writes as
  // \uXXXX, which take 158).
  const CASE = 30;
  const NORMALIZE = 150;
  const ENCODE = 50;
  const NUMBER = 15;
  const DECODE = 8;
  const PARSE = 10;
  const QUOTE = 40;
  const QUOTE_U = 200;
  // One new string per char (split, spread of a string: 62 ns) and per char a regex method may
  // match at (spreading a global matchAll builds a match per char: 320 ns).
  const PIECE = 80;
  const MATCH = 400;
  // Per char of a capture exec returns: the regex engine stepped over at least that much to find
  // it (~10–30 ns per char in a lookahead) without polling interrupts (see chargeMatch).
  const SCAN = 24;
  // Per entry of a Set or Map walked by an iterator (spreading a Map: 192 ns).
  const ENTRY = 250;

  // Per char of a string a native converts to a number (up to ~15 ns for "0.1111…"), hashes
  // (~1.4 ns, Map and Set keys, property keys) or compares (~0.5 ns); per char of a new string.
  const NUM = 16;
  const HASH = 4;
  const COMPARE = 1;
  const CREATE = 1;

  // Converting a number to a string (dtoa, radix 10): ~0.2–0.8 µs, but up to ~36 µs for a value
  // printed with a 3-digit exponent (|x| < 1e-99 or ≥ 1e100; denormals are the slowest). Other
  // radixes: up to ~80 µs outside 1e-20..1e21. Int32 values take a fast path.
  const DTOA = 800;
  const DTOA_MAX = 40000;
  const DTOA_RADIX = 100000;
  // Per element of a typed array joined into a string (an integer: ~0.1 µs).
  const TYPED_JOIN = 150;
  // A call of the prelude's comparator for a sort without one (~0.3 µs).
  const SORT_CALL = 400;

  // Copying one own property (object spread and rest, for-in: 50–130 ns).
  const KEY = 150;
  // Every call through one of the wrappers below runs ~0.5–1 µs of JS before the native.
  const WRAP = 800;
  // Unwinding an exception out of one function (catch, rethrow).
  const LEAVE = 1000;

  // ---- cost meter ----

  // The units left in this phase live in the bot module (a var the instrumented code decrements
  // inline); its header registers a getter and setter for it. Until then, a local stands in.
  let local = Infinity;
  let getLeft = () => local;
  let setLeft = (n) => {
    local = n;
  };
  let phaseLimit = Infinity;
  let registered = false;
  // Per-exception costs; set by the header (they depend on the bundle's largest function).
  let exceptionUnits = 0;
  let perChar = 0;
  let perCharTick = 0;

  function charge(units) {
    if (!(units > 0)) return;
    const left = getLeft() - units;
    setLeft(left);
    if (left < 0) overrun();
  }
  // Out of budget: the host fails every later interrupt check (an uncatchable error), and until
  // the next one comes this sentinel is thrown. Every catch in bot code starts with a charge
  // (chargeCaught / chargeLeaving), which rethrows it, so no catch body runs again this phase;
  // bot code that still runs (a finally, an iterator's return() called while unwinding) stops at
  // its next charge.
  let exhausted = false;
  const OUT_OF_BUDGET = ObjectCtor.freeze({});
  function overrun() {
    exhausted = true;
    exhaust();
    throw OUT_OF_BUDGET;
  }

  // An exception was caught (or created): QuickJS wrote a backtrace for it, which costs about
  // its length times the size of the functions on the stack. The backtrace is written once, so
  // that part is charged once per error object.
  const backtraced = new WeakSetCtor();
  function chargeCaught(e) {
    if (exhausted) throw OUT_OF_BUDGET;
    let units = exceptionUnits;
    if ((typeof e === "object" || typeof e === "function") && e !== null) {
      if (apply(weakSetHas, backtraced, [e])) return charge(units);
      apply(weakSetAdd, backtraced, [e]);
      const d = getOwnPropertyDescriptor(e, "stack");
      if (d !== undefined && typeof d.value === "string") {
        units += d.value.length * perChar;
        charge(units);
        // A deep stack is long; the bot may keep it, so it is cut to the string cap.
        if (d.value.length > maxString && d.configurable) {
          defineProperty(e, "stack", { value: apply(sliceString, d.value, [0, maxString]),
            writable: true, configurable: true });
        }
        return;
      }
    }
    charge(units);
  }
  // Object spread and rest copy every own key of the source; for-in collects the keys of the
  // whole prototype chain up front.
  function chargeSpread(v) {
    if (typeof v === "string") charge(v.length * PIECE);
    else if ((typeof v === "object" || typeof v === "function") && v !== null) {
      charge(ownKeysNative(v).length * KEY);
    }
    return v;
  }
  function chargeForIn(v) {
    if (typeof v === "string") {
      charge(v.length * PIECE);
    } else if (v !== null && v !== undefined) {
      let n = 0;
      for (let p = ObjectCtor(v); p !== null; p = getPrototypeOf(p)) n += ownKeysNative(p).length;
      charge(n * KEY);
    }
    return v;
  }
  // An exception leaving a bot function (instrument.ts wraps every body): built-ins can drop it
  // later without a catch in bot code ever seeing it.
  function chargeLeaving(e) {
    if (exhausted) throw OUT_OF_BUDGET;
    const object = (typeof e === "object" || typeof e === "function") && e !== null;
    if (object && !apply(weakSetHas, backtraced, [e])) chargeCaught(e);
    else charge(LEAVE);
  }
  function register(set, get, charTick, charLoad, exception) {
    deleteProperty(g, "__zs_meter");
    if (registered) throw new TypeErrorCtor("sandbox: the meter is already registered");
    registered = true;
    const left = getLeft();
    getLeft = get;
    setLeft = set;
    setLeft(left);
    perCharTick = charTick;
    perChar = charLoad;
    exceptionUnits = exception;
    return { o: overrun, k: chargeSpread, f: chargeForIn, x: chargeCaught, n: newString,
      y: newKey, w: member, a: spreadArgs, r: chargeLeaving, d: propertyKey };
  }

  // ---- strings ----

  function tooLongString(len) {
    throw new RangeErrorCtor("string length " + len + " is over the sandbox limit of " + maxString);
  }
  function capString(v) {
    if (typeof v === "string" && v.length > maxString) tooLongString(v.length);
    return v;
  }
  // ---- numbers to strings ----

  function dtoaCost(v) {
    if (v === (v | 0)) return 0;
    const a = v < 0 ? -v : v;
    return (a >= 1e100 && a !== Infinity) || (a < 1e-99 && a !== 0) ? DTOA_MAX : DTOA;
  }
  function radixCost(v) {
    if (v === (v | 0)) return 0;
    const a = v < 0 ? -v : v;
    return (a >= 1e-20 && a < 1e21) || a !== a || a === Infinity ? DTOA : DTOA_RADIX;
  }
  // A slow conversion always prints a 3-digit exponent ("3.5e-323"): a string built from one
  // starts or ends with it (instrument.ts sends every string a + builds here).
  function hugeExponentAt(s, i) {
    const sign = s[i + 1];
    const a = s[i - 1];
    const b = s[i + 2];
    const c = s[i + 3];
    const d = s[i + 4];
    return s[i] === "e" && (sign === "-" || sign === "+") && a >= "0" && a <= "9" &&
      b >= "0" && b <= "9" && c >= "0" && c <= "9" && d >= "0" && d <= "9";
  }
  function endsWithHugeExponent(s) {
    return s.length >= 6 && s[s.length - 5] === "e" && hugeExponentAt(s, s.length - 5);
  }
  function startsWithHugeExponent(s) {
    let i = s[0] === "-" ? 1 : 0;
    if (!(s[i] >= "0" && s[i] <= "9")) return false;
    i++;
    if (s[i] === ".") {
      const end = i + 18;
      for (i++; i < end && s[i] >= "0" && s[i] <= "9"; i++);
    }
    return hugeExponentAt(s, i);
  }
  // String(v) for a value a native is about to convert, with the conversion charged. Symbols are
  // left for the native to reject. An object can convert through a number (a valueOf or toString
  // returning one), so its result is charged by its shape.
  function toStr(v) {
    if (typeof v === "string" || typeof v === "symbol") return v;
    if (typeof v === "number") {
      charge(dtoaCost(v));
      return StringCtor(v);
    }
    const s = StringCtor(v);
    if (endsWithHugeExponent(s)) charge(DTOA_MAX);
    return s;
  }
  // A property key that isn't a string or an int32 number (instrument.ts checks those inline).
  // An object is converted here, once, so its conversion can be charged; the key is returned.
  function propertyKey(v) {
    if (typeof v === "number") {
      charge(dtoaCost(v));
    } else if ((typeof v === "object" || typeof v === "function") && v !== null) {
      const k = ownKeysNative({ [v]: 0 })[0];
      if (typeof k === "string") {
        charge(k.length * HASH);
        if (endsWithHugeExponent(k)) charge(DTOA_MAX);
      }
      return k;
    }
    return v;
  }

  // A string the bot code built with +.
  // Few branches on the common path (QuickJS counts them toward its interrupt polls too): most
  // strings start with a letter and don't end in an exponent.
  function newString(s) {
    const n = s.length;
    if (n > 64) {
      if (n > maxString) tooLongString(n);
      charge(n * CREATE);
    }
    if (s[n - 5] === "e" || s[0] <= "9") {
      if (endsWithHugeExponent(s) || startsWithHugeExponent(s)) charge(DTOA_MAX);
    }
  }
  // A computed key in an object literal or class: it may become a function's name.
  function newKey(s) {
    if (s.length > maxString) tooLongString(s.length);
    charge(s.length * HASH);
  }
  function chargeNumber(v) {
    if (typeof v === "string") charge(v.length * NUM);
  }
  function chargeList(list, weight) {
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (typeof v === "string") charge(v.length * weight);
    }
  }
  // A member the instrumented code updates when its object or key isn't a plain name
  // (obj[f()] += s, [a[i]] = list): the value is checked on the way in and out.
  function member(obj, key) {
    return {
      get v() {
        const v = obj[key];
        chargeNumber(v);
        return v;
      },
      set v(v) {
        capString(v);
        chargeNumber(v);
        obj[key] = v;
      },
    };
  }

  // Built-ins that take an iterable call its next() and use what it yields without the bot code
  // seeing it again; bot code can also replace the array iterator. So iterables are read here
  // first, the way the built-in would (snapshot: all next() calls before the built-in runs).
  let arrayValues;
  let arrayNext;
  const ArrayIteratorProto = getPrototypeOf([][iteratorKey]());
  function nativeArrayIteration(v) {
    if (!isArray(v) || hasOwn(v, iteratorKey)) return false;
    const d = getOwnPropertyDescriptor(ArrayProto, iteratorKey);
    const n = getOwnPropertyDescriptor(ArrayIteratorProto, "next");
    return d !== undefined && d.value === arrayValues && n !== undefined && n.value === arrayNext &&
      getPrototypeOf(v) === ArrayProto;
  }
  // The values of an iterable, as a plain array (the same array for one the native iterator walks).
  function listOf(iterable) {
    if (nativeArrayIteration(iterable)) {
      checked("iterable", iterable.length, 0);
      return iterable;
    }
    const out = [];
    let n = 0;
    for (const v of iterable) {
      if (n >= maxArrayLength) tooLong("iterable", n + 1);
      define(out, n++, v);
    }
    return out;
  }
  // The values a built-in is about to read, read once here and charged as strings it may convert.
  // The built-in gets this copy: an element getter could change the original after the check.
  function snapshot(list, len) {
    const out = [];
    for (let i = 0; i < len; i++) {
      const v = list[i];
      chargeNumber(v);
      define(out, i, v);
    }
    return out;
  }
  // An array-like with no prototype (so no iterator) holding the same values.
  function arrayLike(list) {
    const out = {};
    setPrototypeOf(out, null);
    for (let i = 0; i < list.length; i++) define(out, i, list[i]);
    define(out, "length", list.length);
    return out;
  }
  // f(...xs) in bot code: the values reach f (maybe a built-in) unchecked otherwise.
  function spreadArgs(v) {
    const iterated = listOf(v);
    charge(iterated.length * ARRAY);
    const list = snapshot(iterated, iterated.length);
    if (nativeArrayIteration(list)) return list;
    let i = 0;
    const it = { next: () => (i < list.length ? { value: list[i++], done: false }
      : { value: undefined, done: true }) };
    const out = {};
    define(out, iteratorKey, () => it);
    return out;
  }

  // Native functions (filled in at the end of setup). Given one as a callback, a built-in calls
  // it with values the bot code never checked, so it is wrapped to charge its string arguments.
  const natives = new WeakSetCtor();
  function isNative(f) {
    return (typeof f === "function" || typeof f === "object") && f !== null &&
      apply(weakSetHas, natives, [f]);
  }
  function checkedCallback(f) {
    if (!isNative(f)) return f;
    return function (...args) {
      chargeList(args, NUM);
      return apply(f, this, args);
    };
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
    } catch (e) {
      chargeCaught(e);
      return false;
    }
  }

  // The prelude's own conversions of bot values.
  function num(v) {
    chargeNumber(v);
    return +v;
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

  // Number of own keys a native will walk, when it can be known up front without running bot
  // code: strings, arrays, typed arrays and array-likes with a plain length. Other objects: 0
  // (their key count is charged afterwards where the native returns it).
  function sizeHint(o) {
    if (typeof o === "string") return o.length;
    if (typeof o !== "object" || o === null) return 0;
    if (isArray(o)) return o.length;
    if (isTypedArray(o)) return typedLength(o);
    const d = getOwnPropertyDescriptor(o, "length");
    return d !== undefined && hasOwn(d, "value") && typeof d.value === "number" ? toLength(d.value) : 0;
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
  // Every string it returns is capped at maxStringLength.
  function guard(obj, name, cost) {
    replaceMethod(obj, name, (native) => ({
      m(...args) {
        charge(WRAP);
        cost(this, args, name);
        return capString(apply(native, this, args));
      },
    }).m);
  }
  // Built-ins that take a callback: a native one is wrapped (see checkedCallback).
  const CALLBACK_METHODS = new SetCtor(["every", "filter", "find", "findIndex", "findLast",
    "findLastIndex", "forEach", "map", "reduce", "reduceRight", "some", "sort", "toSorted"]);
  const withCallback = (index, cost) => (self, args, name) => {
    args[index] = checkedCallback(args[index]);
    cost(self, args, name);
  };

  const linear = (lengthOf, weight) => (self, _args, name) =>
    checked(name, lengthOf(self), weight);
  // Comparing each element with a string argument (indexOf, includes) or joining with a long
  // separator costs per char too.
  const linearWithStrings = (lengthOf, weight) => (self, args, name) => {
    const len = lengthOf(self);
    checked(name, len, weight);
    for (let i = 0; i < args.length; i++) {
      if (typeof args[i] === "string") charge(len * args[i].length * CHAR);
    }
  };
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
    "flatMap", "join", "toLocaleString"]);
  // Sorting without a comparator compares the elements' strings, converting them in C on every
  // comparison. The same comparator is supplied here, so each conversion is charged (a number,
  // an object's toString), and so is comparing two long strings.
  function defaultCompare(a, b) {
    const x = typeof a === "string" ? a : toStr(a);
    const y = typeof b === "string" ? b : toStr(b);
    if (x.length > 64 && y.length > 64) charge((x.length < y.length ? x.length : y.length) * COMPARE);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const sortCost = (self, args, name) => {
    const own = args[0] !== undefined;
    nlogn(arrayLength, own ? ARRAY : ARRAY + SORT_CALL)(self, args, name);
    if (!own) args[0] = defaultCompare;
  };
  for (const name of Reflect.ownKeys(ArrayProto)) {
    if (ARRAY_CHEAP.has(name)) continue;
    let cost;
    if (name === "sort" || name === "toSorted") cost = sortCost;
    // Calls this.join.
    else if (name === "toString") cost = () => {};
    else cost = linearWithStrings(arrayLength, ARRAY);
    guard(ArrayProto, name, CALLBACK_METHODS.has(name) ? withCallback(0, cost) : cost);
  }
  arrayValues = ArrayProto[iteratorKey];
  arrayNext = ArrayIteratorProto.next;

  function toObject(v, name) {
    if (v === null || v === undefined) throw new TypeErrorCtor(name + " called on null or undefined");
    return ObjectCtor(v);
  }
  // join converts every element in C: they are converted here instead (charged) and the native
  // joins the strings. It is refused before the copy if the result would be over the cap.
  replaceMethod(ArrayProto, "join", (native) => ({
    join(separator) {
      charge(WRAP);
      const o = toObject(this, "Array.prototype.join");
      const len = arrayLength(o);
      checked("join", len, ARRAY);
      const sep = separator === undefined ? "," : toStr(separator);
      if (typeof sep !== "string") throw new TypeErrorCtor("cannot convert a Symbol to a string");
      let chars = len > 1 ? (len - 1) * sep.length : 0;
      if (chars > maxString) tooLongString(chars);
      const parts = [];
      for (let i = 0; i < len; i++) {
        const v = o[i];
        const s = typeof v === "string" ? v : v === undefined || v === null ? ""
          : typeof v === "number" && v === (v | 0) ? "" + v : toStr(v);
        if (typeof s === "string") chars += s.length;
        if (chars > maxString) tooLongString(chars);
        define(parts, i, s);
      }
      return apply(native, parts, [sep]);
    },
  }).join);
  // toLocaleString calls each element's toLocaleString and converts the result in C: done here.
  function localeJoin(o, len) {
    let out = "";
    for (let i = 0; i < len; i++) {
      if (i > 0) out += ",";
      const v = o[i];
      if (v === undefined || v === null) continue;
      const s = toStr(v.toLocaleString());
      if (out.length + s.length > maxString) tooLongString(out.length + s.length);
      out += s;
    }
    return out;
  }
  replaceMethod(ArrayProto, "toLocaleString", () => ({
    toLocaleString() {
      charge(WRAP);
      const o = toObject(this, "Array.prototype.toLocaleString");
      const len = arrayLength(o);
      checked("toLocaleString", len, ARRAY);
      return localeJoin(o, len);
    },
  }).toLocaleString);

  function define(a, i, v) {
    defineProperty(a, i, { value: v, writable: true, enumerable: true, configurable: true });
  }
  function isSpreadable(o) {
    if (typeof o !== "object" || o === null) return false;
    const s = o[Symbol.isConcatSpreadable];
    return s !== undefined ? !!s : isArray(o);
  }
  function concat(...items) {
    charge(WRAP);
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
    charge(WRAP);
    const d = depth === undefined ? 1 : NumberCtor(depth);
    return flatten([], ObjectCtor(this), d === d ? d : 0, undefined, undefined);
  }
  function flatMap(mapper, thisArg) {
    charge(WRAP);
    if (typeof mapper !== "function") throw new TypeErrorCtor("flatMap: mapper is not a function");
    return flatten([], ObjectCtor(this), 1, checkedCallback(mapper), thisArg);
  }
  replaceMethod(ArrayProto, "concat", () => ({ concat }).concat);
  // push, pop and at read the length of a non-array and convert it on every call: refuse
  // anything but a plain number there, as the other array methods do.
  for (const name of ["push", "pop", "at"]) {
    replaceMethod(ArrayProto, name, (native) => ({
      m(...args) {
        if (!isArray(this)) {
          charge(WRAP);
          arrayLength(this);
        }
        return apply(native, this, args);
      },
    }).m);
  }
  replaceMethod(ArrayProto, "flat", () => ({ flat }).flat);
  replaceMethod(ArrayProto, "flatMap", () => ({ flatMap }).flatMap);

  function arrayLikeCost(name, src, weight) {
    if (typeof src === "object" && src !== null) {
      noIteratorGetter(src);
      checked(name, arrayLength(src), weight);
    } else if (typeof src === "string") charge(src.length * CHAR); // + the string iterator
  }
  const arrayLikeArg = (weight) => (_self, args, name) => arrayLikeCost(name, args[0], weight);
  guard(Array, "from", withCallback(1, arrayLikeArg(ARRAY)));

  // A typed array converts every value it is built from to a number. An iterable source is read
  // here first (see listOf) and handed over as an array-like.
  function typedSource(name, args, i) {
    const src = args[i];
    if (typeof src !== "object" || src === null) return;
    if (isTypedArray(src)) {
      checked(name, typedLength(src), TYPED);
      return;
    }
    noIteratorGetter(src);
    let list = src;
    if (src[iteratorKey] !== undefined && src[iteratorKey] !== null) list = listOf(src);
    const len = arrayLength(list);
    checked(name, len, TYPED);
    args[i] = arrayLike(snapshot(list, len));
  }

  // ---- typed arrays and buffers ----

  const TYPED_CHEAP = new SetCtor(["constructor", "at", "subarray", "toLocaleString"]);
  const FLOATS = new SetCtor(["Float16Array", "Float32Array", "Float64Array"]);
  // join converts every element in C (see DTOA). The separator is converted first, so no bot code
  // runs between counting and joining; every element prints at least one char.
  const typedJoinCost = (self, args, name) => {
    if (args[0] !== undefined) args[0] = toStr(args[0]);
    const len = typedLength(self);
    const sep = args[0] === undefined ? 1 : typeof args[0] === "string" ? args[0].length : 0;
    const least = len > 0 ? len + (len - 1) * sep : 0;
    if (least > maxString) tooLongString(least);
    checked(name, len, TYPED_JOIN);
    if (!FLOATS.has(apply(taTag, self, []))) return;
    let units = 0;
    for (let i = 0; i < len; i++) {
      const v = self[i];
      if (v !== (v | 0)) units += dtoaCost(v);
    }
    charge(units);
  };
  for (const name of Reflect.ownKeys(TypedArrayProto)) {
    if (TYPED_CHEAP.has(name)) continue;
    const sorting = name === "sort" || name === "toSorted";
    const cost = name === "join" ? typedJoinCost : (sorting ? nlogn : linear)(typedLength, TYPED);
    guard(TypedArrayProto, name, CALLBACK_METHODS.has(name) ? withCallback(0, cost) : cost);
  }
  replaceMethod(TypedArrayProto, "toLocaleString", () => ({
    toLocaleString() {
      charge(WRAP);
      if (!isTypedArray(this)) throw new TypeErrorCtor("not a TypedArray");
      const len = typedLength(this);
      checked("toLocaleString", len, TYPED_JOIN);
      return localeJoin(this, len);
    },
  }).toLocaleString);
  guard(TypedArray, "from", (_self, args, name) => {
    args[1] = checkedCallback(args[1]);
    typedSource(name, args, 0);
  });
  guard(TypedArrayProto, "set", (self, args, name) => {
    checked(name, typedLength(self), TYPED);
    typedSource(name, args, 0);
  });
  guard(TypedArray, "of", (_self, args) => charge(args.length * TYPED));
  guard(ArrayBuffer.prototype, "slice", (self) => charge(apply(abByteLength, self, []) * BYTE));
  guard(ArrayBuffer.prototype, "resize", (_self, args) => charge(toLength(args[0] = num(args[0])) * BYTE));
  guard(ArrayBuffer.prototype, "transfer", (self) => charge(apply(abByteLength, self, []) * BYTE));

  // Allocation is zero-filled (and copying an array-like walks it), so constructors are charged
  // by size too. The wrapper keeps prototype identity: instanceof and subclassing still work.
  function guardConstructor(name, cost) {
    const Native = g[name];
    installConstructor(name, Native, function (...args) {
      charge(WRAP);
      cost(args);
      if (new.target === undefined) return apply(Native, this, args);
      return construct(Native, args, new.target);
    }, []);
  }
  // Puts Wrapped in place of the global Native with the same statics and prototype.
  function installConstructor(name, Native, Wrapped, dropStatics) {
    setPrototypeOf(Wrapped, getPrototypeOf(Native));
    for (const key of Reflect.ownKeys(Native)) {
      if (key === "length" || key === "name" || key === "prototype") continue;
      if (dropStatics.includes(key)) continue;
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
        if (!isArray(a) && !isTypedArray(a)) {
          try {
            apply(abByteLength, a, []);
            return; // a view on an existing buffer: nothing is copied
          } catch (e) {
            chargeCaught(e);
          }
        }
        typedSource(name, args, 0);
      } else if (args.length > 0) {
        // Convert once, so a valueOf cannot report a different size to the native.
        charge(toLength(args[0] = num(a)) * TYPED);
      }
    });
  }
  guardConstructor("ArrayBuffer", (args) => {
    let size = args.length > 0 ? toLength(args[0] = num(args[0])) : 0;
    const opts = args[1];
    if (typeof opts === "object" && opts !== null) {
      const max = opts.maxByteLength;
      if (max !== undefined) {
        const m = num(max);
        args[1] = { maxByteLength: m };
        if (toLength(m) > size) size = toLength(m);
      }
    }
    charge(size * BYTE);
  });

  // ---- strings ----

  const StringProto = String.prototype;
  // Longest string QuickJS can build; asking for more throws a RangeError natively, so it is not
  // charged (charging would turn that error into a timeout).
  const MAX_STRING = 1073741823;
  const STRING_CHEAP = new SetCtor(["constructor", "at", "charAt", "charCodeAt", "codePointAt"]);
  const SEARCH = new SetCtor(["indexOf", "lastIndexOf", "includes", "startsWith", "endsWith",
    "split", "replace", "replaceAll", "match", "matchAll", "search"]);
  // These treat an undefined argument differently from the string "undefined".
  const UNDEFINED_OK = new SetCtor(["split", "match", "matchAll", "search"]);
  const PER_CHAR = { toLowerCase: CASE, toUpperCase: CASE, toLocaleLowerCase: CASE,
    toLocaleUpperCase: CASE, normalize: NORMALIZE };
  const HTML_ARG = { anchor: true, fontcolor: true, fontsize: true, link: true };
  function guardString(name, cost) {
    replaceMethod(StringProto, name, (native) => ({
      m(...args) {
        charge(WRAP);
        // Convert once here, so the native gets a primitive and cannot run bot code (a
        // toString returning a different string) after we measured it.
        const s = this === null || this === undefined ? this : toStr(this);
        if (typeof s === "string") cost(s, args);
        return capString(apply(native, s, args));
      },
    }).m);
  }
  for (const name of Reflect.ownKeys(StringProto)) {
    if (STRING_CHEAP.has(name)) continue;
    if (name === "toString" || name === "valueOf") {
      // What a String object converts to (+new String(s)): the result may become a number.
      replaceMethod(StringProto, name, (native) => ({
        m() {
          charge(WRAP);
          const s = apply(native, this, []);
          charge(s.length * NUM);
          return s;
        },
      }).m);
    } else if (SEARCH.has(name)) {
      guardString(name, (s, args) => {
        // Naive search is O(haystack × needle).
        let needle = args[0];
        if (typeof needle === "object" && needle !== null) {
          if (!isRegExp(needle)) needle = args[0] = toStr(needle);
        } else if (!(needle === undefined && UNDEFINED_OK.has(name))) {
          needle = args[0] = toStr(needle);
        }
        const m = typeof needle === "string" && needle.length > 1 ? needle.length : 1;
        charge(s.length * m * CHAR);
        // With a regex the native calls its Symbol.split / Symbol.replace (charged below).
        if (typeof needle !== "string") return;
        const most = floor(s.length / (needle.length || 1)) + 1;
        if (name === "split") {
          const limit = args[1] === undefined ? most : (args[1] = num(args[1])) >>> 0;
          charge((limit < most ? limit : most) * PIECE);
        } else if (name === "replace" || name === "replaceAll") {
          chargeReplacement(s, args, name === "replace" ? 1 : most);
        }
      });
    } else if (name === "localeCompare") {
      guardString(name, (s, args) => {
        const that = args[0] = toStr(args[0]);
        if (typeof that === "string") charge((s.length + that.length) * NORMALIZE);
      });
    } else if (name === iteratorKey) {
      // Spreading a string ([...s], Array.from(s)) builds one string per char in a native loop.
      guardString(name, (s) => charge(s.length * PIECE));
    } else if (hasOwn(PER_CHAR, name)) {
      const weight = PER_CHAR[name];
      guardString(name, (s, args) => {
        // normalize(form)
        if (args.length > 0 && args[0] !== undefined) args[0] = toStr(args[0]);
        charge(s.length * weight);
      });
    } else if (hasOwn(HTML_ARG, name)) {
      // anchor(name), link(url), …: the argument is converted and quoted into the result.
      guardString(name, (s, args) => {
        args[0] = toStr(args[0]);
        charge((s.length + (typeof args[0] === "string" ? args[0].length * 6 : 0)) * CHAR);
      });
    } else if (name === "repeat") {
      guardString(name, (s, args) => {
        const n = s.length * (args[0] = num(args[0]));
        // Over QuickJS's own limit (or negative) the native throws its RangeError.
        if (n > maxString && n <= MAX_STRING) tooLongString(n);
        if (n <= MAX_STRING) charge(n * CHAR);
      });
    } else if (name === "padStart" || name === "padEnd") {
      guardString(name, (s, args) => {
        const n = toLength(args[0] = num(args[0]));
        if (args.length > 1 && args[1] !== undefined) args[1] = toStr(args[1]);
        if (n > maxString && n <= MAX_STRING) tooLongString(n);
        if (n <= MAX_STRING) charge((s.length + n) * CHAR);
      });
    } else if (name === "concat") {
      // Also what template literals call.
      guardString(name, (s, args) => {
        let n = s.length;
        for (let i = 0; i < args.length; i++) {
          const a = args[i] = toStr(args[i]);
          if (typeof a === "string") n += a.length;
        }
        if (n > maxString) tooLongString(n);
        charge(n * CHAR);
      });
    } else {
      guardString(name, (s) => charge(s.length * CHAR));
    }
  }

  // The output of a replace is the replacement once per match. "$" patterns expand to the
  // matched text (at most the string in total), the text before or after the match (up to the
  // whole string, per match) or a capture. Captures can overlap (lookahead), so they are charged
  // as exec returns them, once more per such "$": returns how many there are. A replacer
  // function runs as bytecode, but the native copies whatever it returns.
  function chargeReplacement(s, args, matches) {
    const r = args[1];
    if (typeof r === "function") {
      args[1] = function (...a) {
        const out = toStr(apply(r, this, a));
        if (typeof out === "string") charge(out.length * CHAR);
        return out;
      };
      return 0;
    }
    const repl = args[1] = toStr(r);
    if (typeof repl !== "string") return 0;
    let around = 0;
    let other = 0;
    for (let i = apply(indexOfString, repl, ["$"]); i >= 0;
      i = apply(indexOfString, repl, ["$", i + 2])) {
      const next = repl[i + 1];
      if (next === "\u0060" || next === "'") around++;
      else other++;
    }
    charge((matches * (repl.length + around * s.length) + other * s.length) * CHAR);
    return other;
  }

  // Regex methods with many matches build a match or piece per char. The regex engine polls
  // interrupts while it matches, but not while it builds results.
  // Match and replace find one match unless the regex is global; the native reads that from
  // the "global" and "flags" properties, so a getter there counts as global.
  const RegExpProto = RegExp.prototype;
  function isGlobal(rx) {
    try {
      if (apply(regexpGlobal, rx, [])) return true;
    } catch (e) {
      chargeCaught(e);
      return true;
    }
    for (let p = rx; p !== null; p = getPrototypeOf(p)) {
      const d = getOwnPropertyDescriptor(p, "global");
      const f = getOwnPropertyDescriptor(p, "flags");
      if (p !== RegExpProto) {
        if (d !== undefined || f !== undefined) return true;
      } else {
        return d === undefined || d.get !== regexpGlobal || f === undefined || f.get !== regexpFlags;
      }
    }
    return true;
  }
  // exec (and test, and the Symbol methods through exec) converts lastIndex to a number.
  const lastIndexCost = (self) => {
    if (typeof self !== "object" || self === null) return;
    const d = getOwnPropertyDescriptor(self, "lastIndex");
    if (d !== undefined) chargeNumber(d.value);
  };
  // exec builds the match: a copy of every capture. Lookahead captures can overlap, so a global
  // regex can return n² / 2 chars in total: each match is charged by size when exec returns it,
  // and for the scan that found it (the engine polls interrupts only after 10 000 steps per
  // call). The Symbol methods below call exec once per match (split: once per position); a
  // replace copies each capture again per "$" in its replacement (captureCopies).
  let captureCopies = 1;
  function chargeMatch(m) {
    if (!isArray(m)) return;
    let chars = 0;
    for (let i = 0; i < m.length; i++) {
      const c = m[i];
      if (typeof c === "string") chars += c.length;
    }
    if (m.groups !== undefined) chars *= 2;
    charge(m.length * ARRAY + chars * (SCAN + CREATE * captureCopies));
  }
  replaceMethod(RegExpProto, "exec", (native) => ({
    exec(str) {
      charge(WRAP);
      lastIndexCost(this);
      const m = apply(native, this, [toStr(str)]);
      chargeMatch(m);
      return m;
    },
  }).exec);
  const regexpExecWrapped = RegExpProto.exec;
  guard(RegExpProto, "test", (self, args) => {
    lastIndexCost(self);
    args[0] = toStr(args[0]);
  });

  // The descriptor a property lookup finds, without running getters.
  function lookup(o, key) {
    for (let p = o; p !== null; p = getPrototypeOf(p)) {
      const d = getOwnPropertyDescriptor(p, key);
      if (d !== undefined) return d;
    }
    return undefined;
  }
  // The Symbol methods trust what exec returns (a bot's exec could hand them huge captures, or
  // numbers to convert), and split and matchAll build their regex with the species constructor
  // and the flags: these must be the built-ins.
  let regexpCtor;
  function builtinRegExp(rx, species) {
    const e = lookup(rx, "exec");
    const f = lookup(rx, "flags");
    let ok = e !== undefined && e.value === regexpExecWrapped && f !== undefined &&
      f.get === regexpFlags;
    if (ok && species) {
      const c = lookup(rx, "constructor");
      const sp = c !== undefined && c.value === regexpCtor ? lookup(regexpCtor, speciesKey) : undefined;
      ok = sp !== undefined && sp.get === regexpSpecies;
    }
    if (!ok) {
      throw new TypeErrorCtor("sandbox: RegExp methods need the built-in exec, flags and constructor");
    }
  }
  for (const key of [Symbol.match, Symbol.matchAll, Symbol.split, Symbol.replace]) {
    const once = key === Symbol.match || key === Symbol.replace;
    const species = key === Symbol.split || key === Symbol.matchAll;
    replaceMethod(RegExpProto, key, (native) => ({
      m(...args) {
        charge(WRAP);
        builtinRegExp(this, species);
        const s = args[0] = toStr(args[0]);
        const n = typeof s === "string" ? s.length : 0;
        const many = !once || isGlobal(this);
        if (many) charge(n * MATCH);
        let copies = 1;
        if (key === Symbol.replace) copies += chargeReplacement(s, args, many ? n + 1 : 1);
        const saved = captureCopies;
        captureCopies = copies;
        try {
          return capString(apply(native, this, args));
        } finally {
          captureCopies = saved;
        }
      },
    }).m);
  }

  // ---- calls, JSON, object enumeration ----

  // A native target gets the list's values unchecked: charge its strings.
  const argsLength = (i, target) => (self, args, name) => {
    const list = args[i];
    if (typeof list !== "object" || list === null) return;
    const len = arrayLength(list);
    checked(name, len, ARRAY);
    if (isNative(target(self, args))) args[i] = snapshot(list, len);
  };
  guard(Function.prototype, "apply", argsLength(1, (self) => self));
  guard(Reflect, "apply", argsLength(2, (_self, args) => args[0]));
  guard(Reflect, "construct", argsLength(1, (_self, args) => args[0]));
  guard(JSON, "parse", (_self, args) => {
    charge((args[0] = StringCtor(args[0])).length * PARSE);
    args[1] = checkedCallback(args[1]);
  });

  // Control chars and lone surrogates are written as \uXXXX, which is ~20 times slower to quote.
  // Short strings are charged as if they had them; scanning costs about as much as the quoting.
  const SLOW_QUOTE = /[\u0000-\u001f\ud800-\udfff]/;
  function quoteCost(str) {
    if (str.length <= 64) return charge(str.length * QUOTE_U);
    charge(str.length * QUOTE);
    if (apply(regexpExec, SLOW_QUOTE, [str]) !== null) charge(str.length * (QUOTE_U - QUOTE));
  }
  // A String object has an own non-writable, non-configurable length; checked first so ordinary
  // objects don't pay for an exception.
  function isStringObject(v) {
    const d = getOwnPropertyDescriptor(v, "length");
    if (d === undefined || d.writable !== false || d.configurable !== false) return false;
    try {
      apply(stringValueOf, v, []);
      return true;
    } catch (e) {
      chargeCaught(e);
      return false;
    }
  }

  // Whether stringify will convert v with ToNumber (it has a Number's internal slot). A
  // Symbol.toStringTag anywhere on its chain hides that: charged as if it did.
  function numberObject(v) {
    if (lookup(v, toStringTagKey) !== undefined) {
      charge(DTOA_MAX);
      return false;
    }
    return apply(objectToString, v, []) === "[object Number]";
  }

  // The replacer runs in bytecode for every value, so stringify is interrupt-checked; it also
  // checks each array right before stringify walks it, and charges each key and string before
  // stringify quotes it (in one native call, however long the string). An array replacer (a key
  // allow-list) is turned into a function: same output, except keys come out in object order,
  // not list order.
  function stringify(value, replacer, space) {
    return capString(stringifyAny(value, replacer, space));
  }
  function stringifyAny(value, replacer, space) {
    charge(WRAP);
    let keep;
    if (isArray(replacer)) {
      checked("JSON.stringify", replacer.length, ARRAY);
      keep = new SetCtor();
      for (let i = 0; i < replacer.length; i++) {
        const k = replacer[i];
        if (typeof k === "string" || typeof k === "number") keep.add(toStr(k));
      }
      replacer = undefined;
    }
    const user = typeof replacer === "function" ? checkedCallback(replacer) : undefined;
    return nativeStringify(value, function (key, v) {
      if (keep !== undefined && key !== "" && !isArray(this) && !keep.has(key)) return undefined;
      if (user !== undefined) v = apply(user, this, [key, v]);
      quoteCost(key);
      // Stringify turns a String object into its string itself, and a Number object into a
      // number (through its valueOf, maybe bot code); do it here so it is charged.
      if (typeof v === "object" && v !== null) {
        if (isStringObject(v)) v = StringCtor(v);
        else if (!isArray(v) && !isTypedArray(v) && numberObject(v)) v = NumberCtor(v);
      }
      if (typeof v === "string") quoteCost(v);
      else if (typeof v === "number") charge(dtoaCost(v));
      else if (isArray(v)) checked("JSON.stringify", v.length, ARRAY);
      else if (isTypedArray(v)) checked("JSON.stringify", typedLength(v), TYPED);
      return v;
    }, space);
  }
  defineProperty(JSON, "stringify", { value: stringify, writable: true, configurable: true });

  // Cost is linear in the number of keys returned, which we only know afterwards.
  function chargeAfter(obj, name) {
    replaceMethod(obj, name, (native) => ({
      m(...args) {
        charge(WRAP);
        const out = apply(native, this, args);
        charge(out.length * ARRAY);
        return out;
      },
    }).m);
  }
  // Cost is linear in the number of keys returned, which we only know afterwards; for strings,
  // arrays and typed arrays it is also charged up front, so one call can't run long.
  function chargeKeys(obj, name, argIndex, weight) {
    replaceMethod(obj, name, (native) => ({
      m(...args) {
        charge(WRAP);
        charge(sizeHint(args[argIndex]) * weight);
        const out = apply(native, this, args);
        if (isArray(out)) charge(out.length * weight);
        return out;
      },
    }).m);
  }
  for (const name of ["keys", "getOwnPropertyNames", "getOwnPropertySymbols", "freeze", "seal",
    "isFrozen", "isSealed"]) {
    chargeKeys(Object, name, 0, ARRAY);
  }
  for (const name of ["values", "entries", "getOwnPropertyDescriptors"]) {
    chargeKeys(Object, name, 0, OBJECT);
  }
  chargeKeys(Object, "create", 1, OBJECT);
  chargeKeys(Object, "defineProperties", 1, OBJECT);
  chargeKeys(Reflect, "ownKeys", 0, ARRAY);
  // Assigning into a typed array or a length converts each string; defining a property may too.
  function ownStringValues(o) {
    if (typeof o !== "object" || o === null) return;
    const keys = ownKeysNative(o);
    for (let i = 0; i < keys.length; i++) {
      const d = getOwnPropertyDescriptor(o, keys[i]);
      if (d !== undefined) chargeNumber(d.value);
    }
  }
  function descriptorValues(descs) {
    if (typeof descs !== "object" || descs === null) return;
    const keys = ownKeysNative(descs);
    for (let i = 0; i < keys.length; i++) {
      const d = getOwnPropertyDescriptor(descs, keys[i]);
      if (d !== undefined && typeof d.value === "object" && d.value !== null) {
        ownStringValues(d.value);
      }
    }
  }
  // Each source is read here (own enumerable keys, in order) and handed over as a copy.
  guard(Object, "assign", (_self, args) => {
    for (let i = 1; i < args.length; i++) {
      const src = args[i];
      charge(sizeHint(src) * ARRAY);
      if ((typeof src !== "object" && typeof src !== "function") || src === null) continue;
      const keys = ownKeysNative(src);
      charge(keys.length * KEY);
      const copy = {};
      for (let k = 0; k < keys.length; k++) {
        const d = getOwnPropertyDescriptor(src, keys[k]);
        if (d === undefined || !d.enumerable) continue;
        const v = src[keys[k]];
        chargeNumber(v);
        define(copy, keys[k], v);
      }
      args[i] = copy;
    }
  });
  guardKey(Object, "defineProperty", 1, (_self, args) => ownStringValues(args[2]));
  guardKey(Reflect, "defineProperty", 1, (_self, args) => ownStringValues(args[2]));
  guard(Object, "defineProperties", (_self, args) => descriptorValues(args[1]));
  guard(Object, "create", (_self, args) => descriptorValues(args[1]));
  // Reimplemented: the native reads the iterable and hashes every key.
  function fromEntries(iterable) {
    charge(WRAP);
    const list = listOf(iterable);
    charge(list.length * OBJECT);
    const out = {};
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if ((typeof e !== "object" && typeof e !== "function") || e === null) {
        throw new TypeErrorCtor("Object.fromEntries: each entry must be an object");
      }
      let k = e[0];
      const v = e[1];
      if (typeof k === "string") charge(k.length * HASH);
      else k = propertyKey(k);
      define(out, k, v);
    }
    return out;
  }
  defineProperty(Object, "fromEntries", { value: ({ fromEntries }).fromEntries, writable: true,
    configurable: true });
  // Object.groupBy turns what the callback returns into property keys.
  guard(Object, "groupBy", (_self, args) => {
    const f = checkedCallback(args[1]);
    args[1] = typeof f !== "function" ? f : (v, i) => {
      const k = f(v, i);
      return typeof k === "string" ? k : propertyKey(k);
    };
  });
  for (const target of [Map, Set]) {
    if (typeof target.groupBy === "function") guard(target, "groupBy", withCallback(1, () => {}));
  }
  // Functions that convert a property key argument (see propertyKey).
  function guardKey(obj, name, i, cost) {
    guard(obj, name, (self, args) => {
      if (args.length > i && typeof args[i] !== "string") args[i] = propertyKey(args[i]);
      if (cost !== undefined) cost(self, args);
    });
  }
  for (const name of ["getOwnPropertyDescriptor", "hasOwn"]) guardKey(Object, name, 1);
  for (const name of ["get", "set", "has", "deleteProperty", "getOwnPropertyDescriptor"]) {
    guardKey(Reflect, name, 1);
  }
  for (const name of ["hasOwnProperty", "propertyIsEnumerable", "__defineGetter__",
    "__defineSetter__", "__lookupGetter__", "__lookupSetter__"]) {
    guardKey(Object.prototype, name, 0);
  }
  // Reimplemented: the native converts every piece and substitution in C.
  function raw(template, ...subs) {
    charge(WRAP + subs.length * ARRAY);
    const literals = toObject(toObject(template, "String.raw").raw, "String.raw");
    const len = arrayLength(literals);
    checked("String.raw", len, ARRAY);
    let out = "";
    for (let i = 0; i < len; i++) {
      const piece = toStr(literals[i]);
      if (out.length + piece.length > maxString) tooLongString(out.length + piece.length);
      out += piece;
      if (i + 1 < len && i < subs.length) {
        const sub = toStr(subs[i]);
        if (out.length + sub.length > maxString) tooLongString(out.length + sub.length);
        out += sub;
      }
    }
    return out;
  }
  defineProperty(String, "raw", { value: ({ raw }).raw, writable: true, configurable: true });
  for (const name of ["fromCharCode", "fromCodePoint"]) {
    guard(String, name, (_self, args) => charge(args.length * ARRAY));
  }
  // String(v) and new String(v) convert v.
  installConstructor("String", StringCtor, function (...args) {
    charge(WRAP);
    if (args.length > 0) args[0] = toStr(args[0]);
    if (new.target === undefined) return apply(StringCtor, this, args);
    return construct(StringCtor, args, new.target);
  }, []);
  // Number to string: charged by value (see DTOA). The value is read the way the natives do
  // (a Number object's own value, never bot code); anything else makes them throw.
  const NumberProto = NumberCtor.prototype;
  for (const name of ["toString", "toLocaleString", "toFixed", "toPrecision", "toExponential"]) {
    guard(NumberProto, name, (self, args) => {
      const v = apply(numberValueOf, self, []);
      let r = 10;
      if (name === "toString" && args[0] !== undefined) r = args[0] = num(args[0]);
      charge(r >= 10 && r < 11 ? dtoaCost(v) : radixCost(v));
    });
  }
  guard(Array, "of", (_self, args) => charge(args.length * ARRAY));
  // Function names: "bound " + name, capped. A bound native stays a native; bound to strings,
  // it would convert them on every call, so it charges them on every call.
  replaceMethod(Function.prototype, "bind", () => ({
    bind(...args) {
      charge(WRAP + args.length * ARRAY);
      const target = this;
      let out = apply(bindNative, target, args);
      if (isNative(target)) {
        let strings = false;
        for (let i = 1; i < args.length; i++) if (typeof args[i] === "string") strings = true;
        if (strings) {
          const bound = out;
          out = function (...rest) {
            chargeList(args, NUM);
            if (new.target === undefined) return apply(bound, this, rest);
            return construct(bound, rest, new.target === out ? bound : new.target);
          };
          defineProperty(out, "name", { value: bound.name, configurable: true });
          defineProperty(out, "length", { value: bound.length, configurable: true });
        }
        apply(weakSetAdd, natives, [out]);
      }
      const d = getOwnPropertyDescriptor(out, "name");
      if (d !== undefined && typeof d.value === "string" && d.value.length > maxString) {
        defineProperty(out, "name", { value: apply(sliceString, d.value, [0, maxString]),
          configurable: true });
      }
      return out;
    },
  }).bind);

  // Global string functions walk their whole input.
  const GLOBAL_PER_CHAR = { parseInt: NUMBER, parseFloat: NUMBER, isNaN: NUMBER, isFinite: NUMBER,
    escape: ENCODE, encodeURI: ENCODE, encodeURIComponent: ENCODE, unescape: DECODE,
    decodeURI: DECODE, decodeURIComponent: DECODE };
  // isNaN and isFinite convert to a number; the others to a string (a number too: see DTOA).
  // Number.parseInt and Number.parseFloat are separate natives.
  const globalPerChar = (name, weight) => (_self, args) => {
    if (args.length === 0) return;
    if (name === "isNaN" || name === "isFinite") {
      if (typeof args[0] === "number" || typeof args[0] === "symbol") return;
      args[0] = StringCtor(args[0]);
    } else {
      args[0] = toStr(args[0]);
    }
    if (typeof args[0] === "string") charge(args[0].length * weight);
  };
  for (const name of ObjectCtor.keys(GLOBAL_PER_CHAR)) {
    guard(g, name, globalPerChar(name, GLOBAL_PER_CHAR[name]));
  }
  for (const name of ["parseInt", "parseFloat"]) guard(NumberCtor, name, globalPerChar(name, NUMBER));
  // Compiling a pattern is linear in its length. The pattern and flags are converted here
  // (charged), except a regex-like object (Symbol.match), which the native reads itself: its
  // source and flags may be numbers to convert.
  const regexpArgs = (args) => {
    const p = args[0];
    if ((typeof p === "object" || typeof p === "function") && p !== null && !isRegExp(p)) {
      if (lookup(p, Symbol.match) === undefined) args[0] = toStr(p);
      else charge(2 * DTOA_MAX);
    } else if (typeof p === "number") {
      args[0] = toStr(p);
    }
    if (typeof args[0] === "string") charge(args[0].length * CHAR);
    if (args.length > 1 && args[1] !== undefined) args[1] = toStr(args[1]);
  };
  guardConstructor("RegExp", regexpArgs);
  regexpCtor = g.RegExp;
  guard(RegExp.prototype, "compile", (_self, args) => regexpArgs(args));
  // Statics come from the native as they are (see installConstructor); escape builds a string up
  // to 6 times as long as its argument (a string, never converted).
  guard(regexpCtor, "escape", (_self, args) => {
    if (typeof args[0] === "string") charge(args[0].length * ENCODE);
  });
  // source escapes "/" and line breaks: up to twice the pattern.
  defineProperty(RegExpProto, "source", {
    get: getOwnPropertyDescriptor({
      get source() {
        const out = capString(apply(regexpSource, this, []));
        if (typeof out === "string") charge(out.length * CHAR);
        return out;
      },
    }, "source").get,
    enumerable: false,
    configurable: true,
  });

  const setSize = getOwnPropertyDescriptor(Set.prototype, "size").get;
  // Set algebra (union, …) reads the other set through its size, has and keys, which bot code
  // can supply, and hashes what they return in C. Nothing in a bot needs it.
  for (const name of ["union", "intersection", "difference", "symmetricDifference", "isSubsetOf",
    "isSupersetOf", "isDisjointFrom"]) {
    deleteProperty(Set.prototype, name);
  }

  // Set and Map iterators are walked in a native loop by spread, Array.from, new Set(…) and
  // friends, without interrupt checks.
  const mapSize = getOwnPropertyDescriptor(Map.prototype, "size").get;
  for (const [proto, size] of [[Set.prototype, setSize], [Map.prototype, mapSize]]) {
    for (const name of ["values", "keys", "entries", "forEach", iteratorKey]) {
      const cost = (self) => {
        let n = 0;
        try {
          n = apply(size, self, []);
        } catch (e) {
          chargeCaught(e);
        }
        charge(n * ENTRY);
      };
      guard(proto, name, name === "forEach" ? withCallback(0, cost) : cost);
    }
  }

  // new Set(iterable) / new Map(iterable) hash every key in C: read the iterable here (see
  // listOf), charge the keys and add them one by one through "add" / "set", as the spec does.
  for (const [name, adderName, pairs] of [["Set", "add", false], ["Map", "set", true]]) {
    const Native = g[name];
    installConstructor(name, Native, function (iterable) {
      if (new.target === undefined) throw new TypeErrorCtor(name + " must be called with 'new'");
      charge(WRAP);
      const out = construct(Native, [], new.target);
      if (iterable === undefined || iterable === null) return out;
      const adder = out[adderName];
      if (typeof adder !== "function") throw new TypeErrorCtor(name + ": '" + adderName + "' is not a function");
      const list = listOf(iterable);
      charge(list.length * ENTRY);
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!pairs) {
          if (typeof e === "string") charge(e.length * HASH);
          apply(adder, out, [e]);
          continue;
        }
        if ((typeof e !== "object" && typeof e !== "function") || e === null) {
          throw new TypeErrorCtor("Map: each entry must be an object");
        }
        const k = e[0];
        if (typeof k === "string") charge(k.length * HASH);
        apply(adder, out, [k, e[1]]);
      }
      return out;
    }, []);
  }

  // Iterator helpers call their callback with values from the underlying iterator.
  const IteratorCtor = g.Iterator;
  if (typeof IteratorCtor === "function") {
    for (const name of ["map", "filter", "flatMap", "forEach", "some", "every", "find", "reduce"]) {
      guard(IteratorCtor.prototype, name, withCallback(0, () => {}));
    }
  }

  // What objects convert to (+obj, obj == 1, obj < s): the result may become a number in C.
  function chargeResult(obj, name) {
    replaceMethod(obj, name, (native) => ({
      m(...args) {
        charge(WRAP);
        const out = capString(apply(native, this, args));
        chargeNumber(out);
        return out;
      },
    }).m);
  }
  chargeResult(Function.prototype, "toString");
  chargeResult(Object.prototype, "toString");
  chargeResult(Object.prototype, "toLocaleString");
  chargeResult(Error.prototype, "toString");
  chargeResult(RegExpProto, "toString");
  chargeResult(Symbol.prototype, "toString");
  for (const name of ["toString", "toLocaleString"]) {
    const join = ArrayProto[name];
    replaceMethod(ArrayProto, name, () => ({
      m(...args) {
        const out = apply(join, this, args);
        chargeNumber(out);
        return out;
      },
    }).m);
  }
  // Descriptions end up in function names ("[desc]") and strings ("Symbol(desc)").
  const NativeSymbol = Symbol;
  const symbolDescription = (d) => {
    if (d === undefined) return d;
    const s = toStr(d);
    if (s.length > maxString - 8) tooLongString(s.length);
    return s;
  };
  installConstructor("Symbol", NativeSymbol, function (description) {
    if (new.target !== undefined) throw new TypeErrorCtor("Symbol is not a constructor");
    charge(WRAP);
    return NativeSymbol(symbolDescription(description));
  }, []);
  guard(g.Symbol, "for", (_self, args) => {
    args[0] = symbolDescription(args[0]);
    chargeNumber(args[0]);
  });


  // new Error() writes a backtrace (see chargeCaught). Subclasses get the wrapped Error as their
  // prototype, so the native one stays out of reach.
  // The backtrace starts with this wrapper and the native it called; drop those two lines.
  function dropWrapperFrames(e) {
    const d = getOwnPropertyDescriptor(e, "stack");
    if (d === undefined || typeof d.value !== "string") return;
    const first = apply(indexOfString, d.value, ["\n"]);
    const second = first < 0 ? -1 : apply(indexOfString, d.value, ["\n", first + 1]);
    if (second < 0) return;
    const stack = apply(sliceString, d.value, [second + 1, second + 1 + maxString]);
    defineProperty(e, "stack", { value: stack, writable: true, configurable: true });
  }
  const ERROR_NAMES = ["Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError",
    "TypeError", "URIError", "AggregateError", "InternalError", "SuppressedError"];
  for (const name of ERROR_NAMES) {
    const Native = g[name];
    if (typeof Native !== "function") continue;
    // The message is converted (AggregateError(errors, message), SuppressedError(e, s, message)).
    const m = name === "AggregateError" ? 1 : name === "SuppressedError" ? 2 : 0;
    installConstructor(name, Native, function (...args) {
      if (args.length > m && args[m] !== undefined) args[m] = toStr(args[m]);
      const e = new.target === undefined ? apply(Native, this, args) : construct(Native, args, new.target);
      chargeCaught(e);
      dropWrapperFrames(e);
      return e;
    }, []);
    if (name !== "Error") setPrototypeOf(g[name], g.Error);
  }

  // Building the argument list walks the whole array in C.
  guard(Function.prototype, "apply", (_self, args) => checked("apply", arrayLength(args[1]), ARRAY));
  guard(Reflect, "apply", (_self, args) => checked("apply", arrayLength(args[2]), ARRAY));
  guard(Reflect, "construct", (_self, args) => checked("construct", arrayLength(args[1]), ARRAY));

  // Promise code catches exceptions in C and turns them into rejections: the resolve functions
  // when a thenable's "then" getter throws, Promise.all/race/any/allSettled when iterating
  // throws. Those exceptions never reach a catch that charges them, and one at full stack depth
  // costs milliseconds. Promise jobs never run in the sandbox (async functions are rejected by
  // the host's source check), so promises are no use to a bot: Promise is removed.

  // ---- determinism and unavailable features ----

  // BigInt arithmetic runs in C with no interrupt checks (7n ** 300000n takes ~0.5 s), and
  // nothing in a bot needs it. Literals are rejected by the host before evaluation.
  for (const name of ["BigInt", "BigInt64Array", "BigUint64Array", "eval", "WeakRef",
    "FinalizationRegistry", "SharedArrayBuffer", "Atomics", "Promise"]) {
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
  // Read-only, so the instrumentation can rely on Math.f(...) returning a number.
  ObjectCtor.freeze(Math);
  defineProperty(g, "Math", { value: Math, writable: false, enumerable: false, configurable: false });

  // ---- log ----

  // Same formatting as createTickLog in @zerosnake/sdk. The host keeps the lines (so they survive
  // a timeout) and applies the byte limit; emit returns false once the limit is reached.
  let logOpen = false;
  function formatArg(arg) {
    if (typeof arg === "string") return arg;
    try {
      const json = stringifyAny(arg);
      if (json !== undefined) return json;
    } catch (e) {
      chargeCaught(e);
    }
    return typeof arg === "symbol" ? StringCtor(arg) : toStr(arg);
  }
  function log(...args) {
    charge(WRAP);
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

  // ---- natives ----

  // Every function reachable now from the globals, and from the iterator prototypes QuickJS only
  // exposes through instances, is a built-in or one of the wrappers above: never bot code.
  const roots = [g, [][iteratorKey](), new g.Set()[iteratorKey](), new g.Map()[iteratorKey](),
    ""[iteratorKey](), apply(RegExpProto[Symbol.matchAll], /a/g, [""]), function* () {}];
  if (typeof IteratorCtor === "function") {
    roots[roots.length] = apply(IteratorCtor.prototype.map, [][iteratorKey](), [(x) => x]);
    roots[roots.length] = IteratorCtor.from({ next: () => ({ done: true }) });
  }
  const seen = new SetCtor();
  while (roots.length > 0) {
    const o = roots[roots.length - 1];
    roots.length--;
    if (seen.has(o)) continue;
    seen.add(o);
    if (typeof o === "function") apply(weakSetAdd, natives, [o]);
    const keys = ownKeysNative(o);
    for (let i = 0; i < keys.length; i++) {
      const d = getOwnPropertyDescriptor(o, keys[i]);
      for (const v of [d.value, d.get, d.set]) {
        if ((typeof v === "object" && v !== null) || typeof v === "function") roots[roots.length] = v;
      }
    }
    const p = getPrototypeOf(o);
    if (p !== null) roots[roots.length] = p;
  }

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
    // Starts the load phase (module evaluation + init) with its budget, and offers the meter to
    // the module's header.
    begin(limit) {
      phaseLimit = limit;
      setLeft(limit);
      exhausted = false;
      logOpen = true;
      defineProperty(g, "__zs_meter", { value: register, writable: true, configurable: true });
    },
    load(ns, infoJson) {
      deleteProperty(g, "__zs_meter");
      if (!registered) throw new TypeErrorCtor("sandbox: the bundle was not instrumented");
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
      phaseLimit = limit;
      setLeft(limit);
      exhausted = false;
      perChar = perCharTick;
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
    // Units charged in the current phase.
    work() {
      return phaseLimit - getLeft();
    },
    // Never runs bot code: only own data properties and primitive conversions.
    describe(e) {
      if ((typeof e !== "object" && typeof e !== "function") || e === null) {
        return typeof e === "symbol"
          ? "uncaught Symbol"
          : "uncaught " + apply(sliceString, StringCtor(e), [0, 2000]);
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
