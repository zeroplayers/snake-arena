# @zerosnake/checks

The deploy checks of SPEC §6. `zerosnake test` runs them in Node, and the version-check Queue
consumer (#22) runs them in workerd. Both get the same report for the same upload (the one
exception is the wall-clock cap, see [Cost caps](#cost-caps)).

```ts
import { formatReport, runChecks } from "@zerosnake/checks";

const report = await runChecks(
  { bundle, sources: [{ path: "src/bot.ts", bytes: 1234 }, ...] },
  { wasmModule }, // Workers only, as for createSandbox
);
report.passed;          // ready or rejected
JSON.stringify(report); // store it with the version
formatReport(report);   // print it for the author
```

The caller bundles the bot and lists the source files with their sizes. The suite only counts
the sources, it doesn't read them.

## Checks

They run in order. After a failure the remaining checks are `skip`.

| id        | passes when                                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `limits`  | ≤ 50 source files, ≤ 1 MiB of sources, bundle ≤ 256 KiB in UTF-8 (`LIMITS`; the deploy API should import these)                                 |
| `load`    | the first life of the first match loads: the bundle evaluates, default-exports an object with `tick()`, and `init()` returns                    |
| `run`     | `CHECK_SEED_COUNT` (5) matches of `CHECK_TICKS` (1000) ticks against easy, medium, hard and chaos end with no sandbox death and within the caps |
| `qualify` | mean score per life ≥ that of `easy` in the same seat on the same seeds                                                                         |

`run` follows the sandbox's strike rules. A timeout or an exception on its own costs one tick:
the snake repeats its previous action. These ticks show up as warnings. A death by `timeout`
(3 in a row over budget), `error` (3 throws in a row, or `init()` throwing on a respawn) or `oom`
fails the check. So does going over a [cost cap](#cost-caps). The suite stops at the first such
event and reports its seed, tick, life, the sandbox's message and the bot's last 20 log lines.

### Matches

- Default engine config. The lineup is the candidate plus `OPPONENTS` (easy, medium, hard,
  chaos). Every seat respawns as soon as it dies, except on the last tick.
- Only the candidate runs in the sandbox, with a fresh `Sandbox` for every `runChecks` call. The
  house bots run natively: they are our own deterministic code. With the candidate alone in the
  sandbox, an OOM can't depend on what other bots do with the shared heap (the sandbox README
  explains how that can happen in a room).
- The bar comes from the same matches with `easy` in the candidate's seat. That makes it a paired
  comparison: same seeds, same opponents, same spawn order.

### Not recognisable as a check

A bot that knew it was being checked could play like `easy` there and do anything in the arena.
So nothing it can observe is specific to the check (`src/disguise.ts`):

- **Seeds** are the first five 32-bit words of SHA-256(bundle) (`checkSeeds`). Local and server
  agree because the bundle is the same. A bot can't know them, because they depend on its own
  text, so it can't recognise the check by `info.seed` or by its first world. Any edit, even to
  a comment, gives other seeds.
- **Names** follow the arena (#24, RoomDO). Each of the candidate's lives gets a fresh UUID as
  its snake id, and its author is a UUID like a user id. Each opponent is shown either as a
  house bot (`house-<kind>-<tick>-0` by `house:<kind>`) or as some author's deployed bot
  (UUIDs). Which one is decided per match from the seed.
- **Time**: the world starts at a tick between 50 000 and 5 000 000, as in a long-running room,
  and the opponents play 100–600 ticks alone before the candidate spawns. The candidate never
  sees tick 0 or a fresh world.
- **Load**: there is no separate probe life (it used to get `seed: 0`). The load check is the
  candidate's first life in the first match.

Two things still differ from a busy room. A check room always has 5 snakes, which rooms do have
when few bots are queued. The room radius and limits match every room's. With seeds that move on
every edit, a bot close to the bar can "re-roll" its luck by redeploying. The paired baseline
keeps each roll fair, but a borderline bot may pass one version and fail the next. The real
protection against a bot that games the gate is re-qualification from arena ratings (#26): a
version whose rating falls below `easy`'s should lose its place.

### The qualification metric: mean score per life

`score = Σ life scores / number of lives`, pooled over all seeds. Each life's score is the
engine's (`massArea × massScoreFactor + kills × killBonus`). A life that is still running when
the match ends counts as a life with its score so far, as if the 1000-tick window were the life
cap.

We use score per life, not per slot (the total a seat collects over the window, however many
lives it takes), because the arena works in lives:

- a version's rating is its mean score over its last 200 lives (SPEC §4);
- the daily quota is counted in lives (100 per bot), so each life a bot wastes costs it.

So the check measures the number the bot will be ranked by. A per-slot metric would favour bots
that die often but score quickly between deaths, because a respawn costs nothing within a fixed
window. Those bots rank badly per life.

The numbers below are from the first version of this suite, on fixed seeds 101–505 without the
pre-roll. Deploys now get per-bundle seeds, so exact scores differ, but the picture is the same.
Per slot, `easy` collects ~470 over the five seeds (16 lives) and `chaos` ~170 (6 lives). Per
life, `chaos` comes close to `easy` (27.7 vs 29.5).

A reviewer of #48 noted that **medium beats hard per life but not per slot**, and these matches
show the same: per life, medium scores 105.9 and hard 104.0. Hard collects more kills, but it
dies more often while hunting (9 lives against medium's 6). Under the arena's rating, hard would
therefore not rank above medium. That's a tuning question for the house bots (#10) and rating
(#26), not for this gate. The gate only compares a bot with `easy`, and every honest house bot
clears that comfortably (medium and hard both score ~3.5× easy).

| bot                           | score                      | verdict              |
| ----------------------------- | -------------------------- | -------------------- |
| easy (the bar)                | 29.5 (16)                  | passes: a tie passes |
| medium                        | 105.9 (6)                  | passes               |
| hard                          | 104.0 (9)                  | passes               |
| chaos                         | 27.7 (6)                   | rejected             |
| drives straight on (suicidal) | 1.2 (55, 40 into the wall) | rejected             |
| circles on the spot           | 4.4 (13)                   | rejected             |

`chaos` misses the bar, which is fine: it is a random sparring partner, not a ranked bot.

## Cost caps

The sandbox's per-tick budget **does not bound CPU yet** (#60). It counts QuickJS interrupt
polls, and QuickJS polls about once per ~4,300 loop iterations however long the loop body is.
So a bot can stay inside 10 "ops" per tick and still take most of a second per tick. With
`init()`'s 100-op budget, starting each life can take seconds too. A bot with easy's logic plus
an 8-statement padding loop passed the first version of this suite in 141 s, and a 300-statement
body would have taken about 70 minutes.

Until #60 lands, `SuiteBudget` caps the whole suite on top of the per-tick budget:

| cap             | default                                            | deterministic | where it bites                       |
| --------------- | -------------------------------------------------- | ------------- | ------------------------------------ |
| `maxInterrupts` | half the per-tick budget on average over all ticks | yes           | Node and workerd                     |
| `maxWork`       | the same, in native work units                     | yes           | Node and workerd                     |
| `maxMillis`     | 60 s of wall clock, read between ticks and lives   | no            | Node only (workerd's clock is still) |
- A run that hits a cap fails `run` with "too slow" and a hint. `report.run.overrun` names the
  cap, and `report.run.cost` holds the totals.
- The interrupt and work caps are part of the rules: a bot that uses more than half its budget
  on average is rejected, because crowded rooms cost more than these matches.
- They don't bound CPU: a bot can stay under them with slow ops. In Node the wall clock does,
  to within one tick past 60 s.
- In workerd `performance.now()` doesn't advance during computation, so the only backstop there
  is the Worker's CPU limit. The consumer (#22) must treat "exceeded CPU" on a check job as a
  rejection ("too slow"), not as a retryable failure.
- The wall-clock cap makes local and server results differ, but only for bots far slower than
  any honest one.

`CostMeter` (`src/cost.ts`) is the only code that reads costs out of a `TickReport`. When #60
gives the sandbox a real per-opcode meter, its unit is charged there and `opBudget` means CPU.
`runChecks`, `CheckOptions` and the report keep their shape. The skipped test "rejects a long
straight-line loop body by the per-tick budget (#60)" in `checks.test.ts` is to be enabled then.

## Report

`CheckReport` is plain JSON and a pure function of the input, apart from `maxMillis`. It holds
no timings and no randomness. `version` (`REPORT_VERSION`) changes when its shape does. Every
check has `status`, a one-line `summary` and a `hint` (what to fix, when it failed), plus its own
details: limit problems and the largest files, the load error, the fault with log lines, the cap
that was hit, per-seed lives and causes of death, the scores per seed. Messages are in the JSON
as the sandbox wrote them, stacks included. Summaries keep only the first line and where the
error was thrown in `bot.js`.

`formatReport` renders it for a person:

```text
Checks failed: this bot would be rejected.

✓ Limits    1 source file, 131 B of source, bundle 131 B
✓ Loads     the bundle loads and default-exports a bot with tick()
✗ Runs      killed on seed 443573865 at tick 1232152 (life 1): 3 ticks in a row over budget
            What to fix: tick() ran longer than its budget (10 ops, a few milliseconds) 3 ticks in a
            row. Look for a loop that never ends, or work that grows with the game: ...
- Qualifies skipped: fix the problems above first

Last log lines before it died (seed 443573865, tick 1232152):
    tick 0
    ...
```

## Runtime

Whole suite, Node 24, Apple M1 Max, with other work running (`BENCH=1 pnpm vitest run
packages/checks/src/bench.test.ts`):

| bot                                          | time   | result                       |
| -------------------------------------------- | ------ | ---------------------------- |
| easy / medium / hard                         | 3–5 s  | pass                         |
| suicidal                                     | 1.7 s  | rejected: qualify            |
| infinite loop                                | 0.04 s | rejected: timeout death      |
| ~90% of the op budget on every tick          | 8.3 s  | rejected: `maxInterrupts`    |
| easy + 8-statement padding loop (7 ops/tick) | 26 s   | rejected: `maxInterrupts`    |
| easy + 300-statement loop body (5 ops/tick)  | 60 s   | rejected: `maxMillis` (Node) |

Times vary by bundle, because each bundle gets its own seeds. Honest bots cost the candidate's
5000 sandbox ticks, plus ~0.5 s for the baseline and the house bots (including the pre-roll).
That time is bounded only for bots whose ops are cheap. Until #60, the Node bound is the 60 s
cap. In workerd, the bound is the consumer's CPU limit: set `limits.cpu_ms` to the maximum the
plan allows (e.g. 300 000) and reject a job that exceeds it.

Process one check job at a time per isolate. Each `runChecks` holds a sandbox with a wasm heap
of up to 64 MiB while it runs. The `Sandbox` has no `dispose()`: every life is disposed, and the
heap is reclaimed by GC once the call has returned and dropped its reference. An explicit
`Sandbox.dispose()` would be a sandbox change.

`src/workerd.test.ts` runs the suite in workerd (Miniflare) with the wasm passed in as a compiled
module, and checks that the reports are identical to Node's. It covers an honest bot and
suicidal, looping, throwing, OOM and export-less bots (2 seeds × 500 ticks), and the full deploy
configuration once (5 hash seeds × 1000 ticks).
