# Limits

Your bot runs in a QuickJS (WebAssembly) sandbox, `@zerosnake/sandbox`. The same package runs it
everywhere, so a bot that behaves locally behaves the same on the server. On `main` it runs your bot
in `zerosnake sim` / `test` ([#57](https://github.com/zeroplayers/snake-arena/pull/57)) and the
template's tests; the arena rooms ([#56](https://github.com/zeroplayers/snake-arena/pull/56)) and
the check suite ([#54](https://github.com/zeroplayers/snake-arena/pull/54)) that will run it on the
server are in review.

Sources: [`packages/sandbox/README.md`](../packages/sandbox/README.md),
[`sandbox.ts`](../packages/sandbox/src/sandbox.ts),
[`prelude.ts`](../packages/sandbox/src/prelude.ts),
[`source.ts`](../packages/sandbox/src/source.ts); for deploy limits,
[`apps/web/src/shared/deploy.ts`](../apps/web/src/shared/deploy.ts) and
[`apps/web/src/server/cli-api.ts`](../apps/web/src/server/cli-api.ts). The check suite is still in
review; its section says so.

## Per-tick budget

> **Changing in [#62](https://github.com/zeroplayers/snake-arena/pull/62)** (in review, for
> [#60](https://github.com/zeroplayers/snake-arena/issues/60)). Below is the budget on `main`. That
> pull request makes the sandbox instrument every bundle before it runs, so the budget bounds CPU
> time for any code shape. The strikes and deaths stay the same, and in that pull request the
> house bots use at most 3.6% of the budget, so keep `tick()` reasonable and you won't notice. Its
> details may still change:
>
> - the bot's own code is charged too, per statement and syntax node, against the same counter as
>   native work: `opBudget × WORK_PER_OP` = 10 M units per tick, about 10 ms on an M1. The
>   interrupt limit stays as a second limit;
> - data-dependent costs are charged by size: each `catch` by the length of the error's `stack`,
>   object spread and rest and `for…in` per key, `apply` / `Reflect.apply` / `Reflect.construct`
>   per argument, `new Error()` in the prelude;
> - the timeout message becomes `over budget: more than 10000000 cost units`.

Today the budget is `info.opBudget` = **10** per `tick()` call (`DEFAULT_OP_BUDGET`), counted in
two ways. Going over either one is a timeout:

- **Interrupt polls.** QuickJS calls an interrupt handler every so many bytecode branches or
  function calls (roughly every 10 000; [#60](https://github.com/zeroplayers/snake-arena/issues/60)
  measured about one per 4 300 loop iterations). The tick may use 10 of them. This counts loop
  iterations and calls, not how much code runs in each, which is what #60 fixes.
- **Native work.** Built-ins whose cost grows with their input (array methods, string methods,
  `JSON.stringify` / `parse`, `Object.keys`, `Set` / `Map` iteration, regex, …) are charged per
  element or character at their measured cost, about 1 unit per nanosecond. The tick may use
  `opBudget × 1 000 000` units (`WORK_PER_OP`), about 10 ms on an M1.

What happens when a tick goes over:

| Event                            | Result                                                                    |
| -------------------------------- | ------------------------------------------------------------------------- |
| one tick over budget             | the previous action is reused (`{ turn: 0 }` on the first tick); a strike |
| **3 ticks in a row** over budget | death by `timeout`                                                        |
| `tick()` throws                  | the previous action is reused; an error                                   |
| **3 ticks in a row** throwing    | death by `error`                                                          |
| any other outcome                | resets that counter (see below)                                           |

Each counter counts consecutive ticks with its outcome: any tick that isn't a timeout resets the
timeout count, and any tick that isn't an error resets the error count. A tick that both throws
and goes over budget counts as a timeout. A `skipped` tick (see [Memory](#memory)) changes neither.

You can't catch your way out of a timeout: once over budget every later check fails, and the host
counts the tick as a timeout even if the call returned normally.

**Loading.** Evaluating the module and running `init()` share a budget of **100** (`initOpBudget`)
in the same units. Going over it is a `timeout` death before the first tick.

## Memory

| Limit                        | Value                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------- |
| per bot (`memoryLimitBytes`) | **8 MiB**, checked every 10 ticks and right after any tick that grew the heap |
| stack                        | 256 KiB                                                                       |
| array length                 | array and typed-array methods throw a `RangeError` above 100 000 elements     |
| shared wasm heap             | 64 MiB for all bots in one sandbox (one room)                                 |

When a check finds the bot over its limit, or an allocation fails, the bot dies at once with cause
`error`. Catching the error doesn't help: the host watches the heap itself. If the shared heap runs
out because **another** bot hogged it, that bot is killed and your tick is just discarded (outcome
`skipped`: previous action, no strike).

## Logs

`log()` and `console.*` keep at most `info.logLimitBytes` = **1024** UTF-8 bytes per tick. See
[Bot API: `log()`](bot-api.md#log) for how lines are cut.

## Forbidden features

The sandbox has no I/O and no clock. Everything here is enforced by the sandbox, not by convention.

**Rejected before loading** (`checkSource` in [`source.ts`](../packages/sandbox/src/source.ts)).
These checks scan the whole bundle text, **including strings and comments**:

- **`async`** anywhere as a whole word: async functions, methods, arrows, generators. Promise jobs
  never run in the sandbox, so nothing after an `await` would ever execute. Because the check is
  textual, a string containing the word `async` (say, in a log message) also rejects the bot, and
  so does a comment that survives bundling. esbuild drops ordinary comments but keeps legal ones
  (`/*! … */`, `@license`), which some dependencies have.
- **BigInt literals** such as `10n` or `0xffn`. BigInt arithmetic runs in C without interrupt
  checks.

> **More rejections in [#62](https://github.com/zeroplayers/snake-arena/pull/62)** (in review). Its
> instrumentation parses the bundle and also rejects, with a load death (`error`): any `import`
> (dynamic too), identifiers starting with `__zs`, destructuring in a `catch (…)` clause, object
> rest other than `const { a, ...rest } = value` or `({ a, ...rest } = value)`, functions with more
> than 3 000 syntax nodes, and brackets nested more than 200 deep. Syntax errors then read
> `SyntaxError: <message>`. An esbuild bundle of ordinary TypeScript passes; split very long
> functions.

**Missing or blocked at runtime:**

| Not available                                                                  | Why                                             |
| ------------------------------------------------------------------------------ | ----------------------------------------------- |
| `Date`, timers, `fetch`, any I/O                                               | determinism; there is no host API               |
| `import` of anything (the bundle must be one self-contained file)              | no module loader                                |
| `eval`, `Function(...)`, and the constructors of generator and async functions | no code from strings                            |
| `Proxy`                                                                        | not compiled into the context                   |
| `BigInt`, `BigInt64Array`, `BigUint64Array`, `DataView` BigInt methods         | uncharged C arithmetic                          |
| `WeakRef`, `FinalizationRegistry`, `SharedArrayBuffer`, `Atomics`              | nondeterministic or pointless here              |
| `Promise.try`                                                                  | could swallow the over-budget interrupt         |
| top-level `await`                                                              | the module must finish evaluating synchronously |

`Math.random()` works and is **seeded per life** from `info.seed`, so a life is reproducible.
`console.*` writes to your log. Everything else in standard JavaScript (ES2023: classes, `Map`,
`Set`, typed arrays, `JSON`, `RegExp`, generators, …) is available.

## Bundle and deploy limits

> The deploy API that enforces these is merged
> ([#52](https://github.com/zeroplayers/snake-arena/pull/52)): the numbers are `DEPLOY_LIMITS` in
> [`apps/web/src/shared/deploy.ts`](../apps/web/src/shared/deploy.ts), path and name rules are
> `sourcePathProblem` and `checkBotName` in
> [`apps/web/src/server/cli-api.ts`](../apps/web/src/server/cli-api.ts), and "one active version" is
> the unique index `versions_bot_ready_idx` in
> [`apps/web/src/db/schema.ts`](../apps/web/src/db/schema.ts). The check suite repeats the bundle
> limits locally ([#54](https://github.com/zeroplayers/snake-arena/pull/54),
> `packages/checks/src/limits.ts`). The CLI commands `login` and `deploy` are in progress
> ([#21](https://github.com/zeroplayers/snake-arena/issues/21)), and without the check consumer
> ([#22](https://github.com/zeroplayers/snake-arena/issues/22)) a deployed version stays
> `validating`.

`zerosnake deploy` bundles your `src/` with esbuild into one ESM file and uploads the bundle plus
the source files (sources are public on your bot's page).

| Limit                      | Value                                                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| source files               | **50**                                                                                                                                               |
| total size of sources      | **1 MiB** (UTF-8)                                                                                                                                    |
| bundle                     | **256 KiB** (UTF-8)                                                                                                                                  |
| one source path            | 200 characters, relative, `/`-separated, no empty, `.` or `..` segments, only letters, digits and `. _ - @ +`; no two paths that differ only in case |
| request body               | 3 MiB                                                                                                                                                |
| bots per author            | **3**                                                                                                                                                |
| deploys per author per day | **20** (UTC day); versions rejected by the checks count                                                                                              |
| active versions per bot    | **1**: a new version that passes the checks replaces the old one                                                                                     |
| lives per bot per day      | **100** (UTC day, all versions of the bot); a life counts when the matchmaker hands it to a room, unless the room never starts it                    |

Bot names are 1–40 characters; the slug (the URL segment `/@you/<slug>`) is 1–32 of `a-z`, `0-9`
and `-`, not starting or ending with `-`. The per-day and per-author numbers can be changed per
environment.

## Check suite and qualification

> **In review** ([#54](https://github.com/zeroplayers/snake-arena/pull/54),
> `packages/checks/README.md`). Once it lands, `zerosnake test` runs it locally (today `test` only
> bundles your bot and loads it), and the server runs the same suite on every deploy (the queue
> consumer is [#22](https://github.com/zeroplayers/snake-arena/issues/22), not built yet). Same
> bundle, same report.

A new version is `validating` until the checks finish, then `ready` (it replaces your previous
version in the arena) or `rejected` (with a report the CLI prints). The checks run in order and
stop at the first failure:

| Check     | Passes when                                                                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `limits`  | the bundle and sources are within the limits above                                                                                                          |
| `load`    | the bundle evaluates, default-exports an object with `tick()`, and `init()` returns                                                                         |
| `run`     | 5 matches of 1000 ticks against the house bots easy, medium, hard and chaos end with no `timeout`, `error` or out-of-memory death, and within the cost caps |
| `qualify` | your **mean score per life** is at least that of the `easy` house bot in your seat on the same seeds                                                        |

Details that matter when a check fails:

- Single over-budget or throwing ticks are allowed (they show up as warnings); a death from them
  fails `run`. The report gives the seed, tick, the sandbox's message and your last 20 log lines.
- **Cost caps** (until [#62](https://github.com/zeroplayers/snake-arena/pull/62) lands): on
  average over all ticks you may use at most **half** of the per-tick budget, in interrupts and in
  native work. Locally the whole suite also stops after 60 s of wall-clock time. A bot that hits a
  cap is rejected as "too slow".
- The 5 seeds are derived from a hash of your bundle, so any change, even to a comment, gives
  different matches. Your bot can't tell a check match from an arena room: the tick counter starts
  high, opponents have played a while before you spawn, and names look like the arena's.
- Qualification compares lives, not seats: a bot that dies often but scores fast in between will
  fail. A life still running at tick 1000 counts with its score so far.

The house bots live in [`bots/house`](../bots/house); `easy` is the bar.
