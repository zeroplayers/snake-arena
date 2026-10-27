# @zerosnake/sandbox

Runs bot code in QuickJS (wasm) the same way in Node (CLI, tests) and in a Durable Object (arena).
Background and measurements: [spike #2](../../spikes/quickjs-do/RESULTS.md).

```ts
import { createSandbox, DEFAULT_OP_BUDGET } from "@zerosnake/sandbox";

const sandbox = await createSandbox(); // one per room / per CLI run
const life = sandbox.startLife(bundle, info); // info.opBudget = DEFAULT_OP_BUDGET
const report = life.tick(state);
// report.action    apply this (the previous action on timeout/error)
// report.death     set on the tick the bot dies: pass death.fault to the engine's FaultMap
// report.log, report.interrupts, report.work   for traces
life.dispose();
```

`bundle` is an ESM file that default-exports `defineBot({ init, tick })` (bundle the SDK into it).
`startLife` instruments it (see [Metering](#metering-srcinstrumentts)) and caches the result per
sandbox, so callers pass the bundle as built. To reject a bad bundle before running it (CLI,
deploy checks), call `instrument(bundle)`: `{ ok: false, error }` is what the bot's load death
would say.

## Workers

Workers can't compile wasm at runtime, so import the module and pass it in. Wrangler only treats
specifiers ending in `.wasm` as compiled modules, and the package export (`./wasm`) doesn't end in
one, so import the file by path (see `spikes/quickjs-do/src/worker.ts`):

```ts
import wasmModule from "../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm";
const sandbox = await createSandbox({ wasmModule });
```

`src/workerd.test.ts` runs the same bot in workerd (Miniflare) and in Node and checks that every
report is identical.

## Rules for a life

- One QuickJS runtime + context per life: module state and `mem` persist between ticks, nothing
  survives to the next life.
- Budget per tick, two limits: `info.opBudget × WORK_PER_OP` cost units (10 M by default, ≈ 10 ms
  of CPU on an M1; `report.work`), charged by the bot's own code and by native built-ins, and
  `info.opBudget` interrupt-handler calls (QuickJS calls it about every 10 000 bytecode branches or
  C-function calls; `report.interrupts`). Over either → previous action and a strike; 3 strikes in
  a row → death `timeout`. Exceptions 3 ticks in a row → death `error`. Once over budget, every
  later interrupt check fails, no `catch` in bot code runs again in that tick (each one rethrows),
  and the host counts the tick as a timeout even if the call returned normally.
- Module evaluation + `init()` share a budget of `initOpBudget` (100), in both units.
- Out of memory → death `error` (reason `oom`) at once, and the runtime is freed. A bot can't
  survive by catching the error: the host watches the shared heap itself (see below).
- Outcome `skipped`: the shared heap ran out during this bot's tick because another bot was over
  its limit (that bot is killed). The tick is discarded: previous action, no strike, no error.
- `Math.random` is seeded from `info.seed`, and `Math` is read-only. No `Date`, `fetch`, timers,
  `import`, `eval`/`Function`, `Proxy`, `BigInt` (literals are rejected by `checkSource`), `WeakRef`,
  `Promise`, or the Set methods `union`, `intersection`, `difference`, `symmetricDifference`,
  `isSubsetOf`, `isSupersetOf` and `isDisjointFrom` (they read the other set through methods bot
  code can supply).
- Strings are at most `MAX_STRING_LENGTH` (16 384) UTF-16 units: building a longer one (`+`, `+=`,
  a template, `repeat`, `join`, `JSON.stringify`, …) throws a `RangeError`, before the result is
  stored. Longer string literals, template parts, names and regex literals are rejected at load.
  An error's `stack` is cut to that length. `log()` is capped separately (`logLimitBytes`).
- `Array.prototype.push`, `pop` and `at` on something that isn't an array need a plain number
  `length`, like every other array method.
- No `import` (not even dynamic), no identifiers starting with `__zs`, no destructuring in a
  `catch` clause, object rest only as `const { a, ...rest } = value` or `({ a, ...rest } = value)`,
  no function with more than 3 000 syntax nodes, no brackets nested more than 200 deep:
  `instrument` rejects these with a message (see below for why).
- No `async` and no `Promise`: `checkSource` rejects the keyword, and the prelude removes
  `Promise`. Promise code catches exceptions in C and turns them into rejections (including the
  interrupt that ends an over-budget tick), so no `catch` would ever charge them, and promise jobs
  never run in the sandbox anyway.
- `log()` and `console.*` go to the tick's log, capped at `info.logLimitBytes` with the SDK's
  truncation rules. Lines logged before a timeout are kept. Unlike the SDK's `createTickLog`, an
  empty line costs 1 byte, so `log('')` in a loop can't keep unbounded lines.

## Metering (`src/instrument.ts`)

QuickJS polls interrupts once per ~4 300 loop iterations or calls whatever runs in between, so
an interrupt budget alone let a 300-statement loop body run ~830 ms per tick without a strike
(#60). So every bundle is rewritten before it runs (acorn parse, text insertions, ~1–2 ms for a
house bot, ~40 ms for 200 KB), and pays for its own code:

- Regions: the module body, each function body, each loop body (charged per iteration, including
  the loop's test and update) and `if`/`switch` branches heavier than a threshold. Code can only
  run again by entering a region again, so charging a region's whole static weight on entry
  bounds the work between two charges by the size of the code. A charge is
  `if ((__zs_g -= units) < 0) __zs_o();` on a module-scoped `var`.
- Weights per syntax node, calibrated on adversarial loops (straight-line bodies, deep
  expressions, huge literals, call chains, closures, classes, string building, spreads, …) so
  that one unit costs at most ~1 ns on an M1. Honest code is over-charged instead (a tight
  numeric loop ~2–3×), which is the price of a static model.
- Data-dependent syntax goes through helpers that charge by size first: object spread and rest
  (own keys), `for…in` (keys of the whole prototype chain). Array spread, `for…of` and array
  destructuring use the array iterator, which the prelude charges; `apply`, `Reflect.apply` and
  `Reflect.construct` are charged by argument count.
- Exceptions: QuickJS writes a backtrace for every Error and decodes each frame's line from the
  start of its function, so one exception at full stack depth (~1 100 frames) in a large function
  cost up to ~95 ms. Each `catch` (and each `finally` that could swallow an exception, which gets a
  charging `catch` that rethrows) and each `new Error()` charges by the length of `stack` at a
  per-char rate set by the bundle's largest function, plus the largest parameter list (a
  parameter pattern can throw before the function's own charge). Functions are capped at 3 000
  syntax nodes, which keeps one exception under ~8 M units.
- Strings: comparing, hashing or converting a string to a number runs in C in time linear in
  its length, as one bytecode (`+s` on `"0.1111…"` costs ~6–15 ns per char), so a short loop on a
  long string ran for minutes per tick. Every place a string operand can reach such an operation
  is charged by its length: `==`/`<`/arithmetic/unary operands (16 units per char), `===` and
  `switch` (1 per char), property keys and `in` (4 per char), arguments of every call (a built-in
  may convert them), return and yield values (a `valueOf`, getter, comparator or iterator feeds
  them to built-ins), and values stored into `a[i]` or `a.length`. The check is inline
  (`(typeof v === "string" && (__zs_g -= v.length * 16) < 0 && __zs_o(), v)`, ~40 ns), so it is
  left out where it can't matter: a scope analysis (`src/types.ts`) proves which variables only
  ever hold numbers (`const dx = p.x - q.x`, loop counters; `Math.f()` returns a number since
  `Math` is read-only), and calls by name to the bot's own functions skip the argument checks
  (and their return checks when the name is only ever called). The prelude charges what built-ins
  read on their own: a native passed as a callback (`strs.map(Number)`), elements of an array or
  iterable it converts or hashes (typed arrays, `new Set`, `Object.fromEntries`, `apply`, spread
  arguments, `sort`), `String`/`Array`/`Function`/`Object`/`Error`/`RegExp` conversion methods,
  `lastIndex`, bound arguments. Iterables those built-ins would walk are read in the prelude first,
  so a replaced array iterator or a hand-written `next()` can't feed them unchecked values.
- Compound assignments and updates of a member whose object or key isn't a plain name go
  through a small accessor (`__zs_w(obj, key).v += x`), and `x += y` becomes `x = x + (y)`, so
  the string cap applies before anything is stored. Each inline check counts as 16 syntax
  nodes of its function (for the size limit and the backtrace rate).
- Exceptions that built-ins drop: closing an iterator after an exception ignores what its
  `return()` throws, and `return()` can run code that does the same again, so exceptions piled up
  before any `catch` charged them (1.1 s per tick). Every function body now charges an exception
  on its way out (the backtrace once per error object, 1 000 units per frame after that), a
  `for…of` body charges it before the loop closes its iterator, and a destructuring `for…of` head
  is moved into that body.
- Out of budget, the meter throws a sentinel that every instrumented `catch` rethrows, instead of
  spinning until the next interrupt check: unwinding can still run bot code (a `finally`, an
  iterator's `return()`), and each of those now stops at its first charge.
- The header registers the counter with the prelude, which charges native built-ins against
  the same counter and deletes the global it used for the handshake. Bot code can't reach the
  counter: identifiers starting with `__zs` are rejected, the counter is a lexical binding, and
  there is no `eval`, `with` or `Function`. Line numbers are unchanged (the header goes before
  line 1), so errors still point into the bundle.

Measured on an M1 under load (other test suites running): every adversarial shape in
`src/metering.test.ts` is stopped within ~5–20 ms per tick (it was up to seconds; the string rows
of the review of #62 took 29–156 s). On real game states the house bots use ≤ 9.2% of the budget
and the template bot 4.4%. Their CPU per tick is ~2–11% over `main` for the code-shape metering
and, on top of that, +7–21% (SDK example, easy), +37% (template) and +47–60% (medium, hard,
chaos) for the string checks: member reads in arithmetic (`p.x - head.x`) can't be proven
numeric, and each check costs about as much as the operation it guards.

## Hardening (`src/prelude.ts`)

QuickJS only checks for interrupts between bytecode and C-function calls. A built-in that loops
in C (`indexOf` on a sparse array of length 1e8: ~4 s) runs between two checks, and a bot can call
cheap-looking built-ins thousands of times per check. So the prelude wraps every built-in whose cost
grows with its input:

- Array and typed-array methods throw a `RangeError` above `maxArrayLength` (1e5).
- Each call is charged to the per-tick cost meter (≈ 1 unit per ns: array element 100, typed-array
  element 10, byte or char 1, plus ~800 for the wrapper itself). Over `opBudget × WORK_PER_OP` the
  tick times out like an interrupt-budget overrun (the bot can't catch it).
- `concat`, `flat` and `flatMap` are reimplemented in JS (they read several arrays in one native call,
  so a getter could grow one after it was checked).
- Lengths are read the way the native will read them, without running bot code; accessor `length`s
  and `Symbol.iterator` getters on array-likes are refused.
- Also charged: `Object.keys`/`values`/`entries`/`assign`/`getOwnPropertyDescriptors`/`freeze`/…
  (by the size of strings, arrays and typed arrays up front and by the keys returned),
  `String.raw`/`fromCharCode`, `bind`, `Array.of`, Set algebra (`union`, …), `parseInt`/`parseFloat`/
  `encodeURI`/…, `RegExp` compilation, and string arguments to array methods (`join` separators,
  `indexOf` of a long string).
- Strings are charged per char at the measured cost of each built-in: copying and searching 1,
  case mapping 30, `normalize`/`localeCompare` 150, URI encoding 50, `JSON.parse` 10.
  `JSON.stringify` charges each key and string before it quotes it (40 per char, or 200 if the
  string has chars it writes as `\uXXXX`).
- Built-ins that make one value per char are charged for each one: `split`, spreading a string
  (`[...s]`, `Array.from(s)`), and regex `match`/`matchAll`/`split`/global `replace` (also called
  through `RegExp.prototype[Symbol.*]`). A replace is charged for its output: the replacement
  once per possible match, each ``$` `` or `$'` in it as the whole string, and whatever a
  replacer function returns.
- Iterating a `Set` or `Map` (spread, `Array.from`, `new Set(set)`, `forEach`) is charged per
  entry up front.

Memory: emscripten builds of QuickJS don't count allocation sizes, so `setMemoryLimit` only stops a
single allocation above the limit. The real guards:

- the capped wasm heap (`wasmMemoryCapBytes`, 64 MiB, shared by the sandbox);
- a `computeMemoryUsage()` check against `memoryLimitBytes` (8 MiB) every `memoryCheckInterval`
  (10) ticks, and right after any tick that grew the heap (~25 µs for a typical bot);
- the host hooks `memory.grow()`, which emscripten calls to grow the heap. When every attempt fails,
  an allocation failed. Then every bot over its limit is killed; if the bot that was running
  isn't one of them, its tick is `skipped`; if nobody is over, the running bot dies.

The cap should cover bots × `memoryLimitBytes`, or honest bots can run the heap out together.

## Known gaps

The meter bounds what code costs by its shape. Some data can still make one cheap operation
slow; these were verified and are left to the DO's CPU limit and the room backstop (replay the
batch with bots isolated, ban the version):

- **Strings a built-in reads on its own.** Everything above charges strings where bot code hands
  them over; a built-in that reads a string the bot stored earlier, by a path not listed there,
  converts it uncharged. The string cap bounds one such read (16 384 chars: ~0.1–0.25 ms for a
  number conversion). None is known; this is the residue of a list, not a proof.
- **Exceptions dropped while destructuring an iterator** (`const [[a]] = it`, `[x = f()] = it`,
  array-pattern parameters): as for `for…of`, the iterator's `return()` runs before the exception
  reaches a charge. With `return()` recursing into the same pattern, 200 levels at half the stack
  depth take ~100–150 ms per tick (for-of: ~7 ms). Closing it means moving those patterns into
  code that charges first, as for `for…of` heads.
- **Deep prototype chains**: a property lookup walks the chain in C. A bot can build a chain
  20 000 objects deep over a few ticks (`o = Object.create(o)`, ~2 M units per 2 000), and then
  each `o.missing` costs O(depth): ~4.6 s per tick until its three strikes. Closing it means
  capping the depth wherever a prototype is set (`Object.create`, `setPrototypeOf`, `__proto__`,
  `new` and the species/`this` constructors of built-ins).
- One exception can overshoot a tick: it is charged right after QuickJS builds its backtrace,
  so a tick costs at most its budget plus one exception (≤ ~8 M units at the function size cap).
- The inline checks add bytecode branches, so loops reach the interrupt limit sooner: a tight
  loop over member reads now polls about twice as often as before. Honest bots stay at 1–2
  interrupts per tick (limit 10).
- Getters run as calls the meter can't see at the property access; their bodies are charged, the
  call itself is bounded by the interrupt budget.
- Weights are calibrated on an M1 (≈ 1 unit per ns at worst). Cloudflare runs QuickJS ~1.5×
  slower (spike #2), so the default budget there is ~15 ms of CPU at worst.
- Work weights are worst cases measured on an M1 (≈ 1 unit per ns). Regex methods also poll
  interrupts inside the regex engine, but a single poll can cover a few ms of match building.
- Which bot hits the shared heap cap first depends on the other bots in the sandbox, so OOM deaths
  are not reproducible across rooms (everything else is).
- `JSON.stringify` with an array replacer emits keys in object order, not list order.
- Starting a life costs ~3.7 ms (prelude setup), versus ~0.3 ms for a bare context, plus the first
  `instrument` of each bundle per sandbox.
