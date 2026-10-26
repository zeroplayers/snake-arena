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
- Budget per tick: `info.opBudget` interrupt-handler calls (QuickJS calls it about every 10 000
  bytecode branches or C-function calls; ≈ 0.5 ms each on an M1). Over budget → previous action and a
  strike; 3 strikes in a row → death `timeout`. Exceptions 3 ticks in a row → death `error`.
- Module evaluation + `init()` share a budget of `initOpBudget` (100).
- Out of memory → death `error` (reason `oom`) at once, and the runtime is freed.
- `Math.random` is seeded from `info.seed`. No `Date`, `fetch`, timers, `import`, `eval`/`Function`,
  `Proxy`, `BigInt` (literals are rejected by `checkSource`), `WeakRef`.
- `log()` and `console.*` go to the tick's log, capped at `info.logLimitBytes` with the SDK's
  truncation rules. Lines logged before a timeout are kept.

## Hardening (`src/prelude.ts`)

QuickJS only checks for interrupts between bytecode and C-function calls. A built-in that loops
in C (`indexOf` on a sparse array of length 1e8: ~4 s) runs between two checks, and a bot can call
cheap-looking built-ins thousands of times per check. So the prelude wraps every built-in whose cost
grows with its input:

- Array and typed-array methods throw a `RangeError` above `maxArrayLength` (1e5).
- Each call is charged to a per-tick **native work** counter (≈ 1 unit per ns: array element 100,
  typed-array element 10, byte or char 1). Over `opBudget × WORK_PER_OP` the tick times out like an
  interrupt-budget overrun (the bot can't catch it).
- `concat`, `flat` and `flatMap` are reimplemented in JS (they read several arrays in one native call,
  so a getter could grow one after it was checked).
- Lengths are read the way the native will read them, without running bot code; accessor `length`s
  and `Symbol.iterator` getters on array-likes are refused.

Memory: emscripten builds of QuickJS don't count allocation sizes, so `setMemoryLimit` only stops a
single allocation above the limit. The real guards are the capped wasm heap (`wasmMemoryCapBytes`,
64 MiB, shared by the sandbox) and a `computeMemoryUsage()` check every `memoryCheckInterval` (10)
ticks against `memoryLimitBytes` (8 MiB); the check costs ~25 µs for a typical bot.

## Known gaps

- **Operators on huge strings** (`===`, `<`, `+`, using one as a property key) and object spread
  over huge objects run in C uncharged, and nothing in JS can intercept them. A bot can build
  strings of tens of MB within one tick (`a = a + a`; the memory check only runs between ticks), and
  `for (;;) a === b` on two 16 MB strings runs for over a minute inside one tick (verified). Only
  the DO's CPU limit stops that, so the room backstop (replay the batch with bots isolated, ban
  the version) is required. Closing it needs a QuickJS build with real allocation accounting (so
  `setMemoryLimit` bounds strings) or a more frequent interrupt counter.
- Which bot hits the shared heap cap first depends on the other bots in the sandbox, so OOM deaths
  are not reproducible across rooms (everything else is).
- `JSON.stringify` with an array replacer emits keys in object order, not list order.
- Starting a life costs ~3 ms (prelude setup), versus ~0.3 ms for a bare context.
