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

| id        | passes when                                                                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `limits`  | ≤ 50 source files, ≤ 1 MiB of sources, bundle ≤ 256 KiB in UTF-8 (`LIMITS`; the deploy API should import these)                                                                       |
| `load`    | the first life of the first match loads: the bundle evaluates, default-exports an object with `tick()`, and `init()` returns                                                          |
| `run`     | `CHECK_SEED_COUNT` (5) arena-style rooms with house bots, each watched for `CHECK_TICKS` (1000) ticks from the candidate's first spawn, end with no sandbox death and within the caps |
| `qualify` | mean score per life ≥ that of `easy` in the same seat on the same seeds                                                                                                               |

`run` follows the sandbox's strike rules. A timeout or an exception on its own costs one tick:
the snake repeats its previous action. These ticks show up as warnings. A death by `timeout`
(3 in a row over budget), `error` (3 throws in a row, or `init()` throwing on a respawn) or `oom`
fails the check. So does going over a [cost cap](#cost-caps). The suite stops at the first such
event and reports its seed, tick, life, the sandbox's message and the bot's last 20 log lines.

### Matches

Each match is one arena room, run by RoomDO's own rules (`src/room-rules.ts`, a verbatim port
of `houseFill` and `batchTicks` from `apps/arena`, PR #56):

- Every arena room starts at tick 0 and its tick only grows, and a candidate often joins a
  young room. So half the check rooms open at tick 0. The others are older rooms that open at a
  tick from 1 000 to 9 999 999, the same share for each power of ten.
- A room runs in batches. A batch lasts `batchTicks(bots, starts)` ticks, the arena's
  worst-case sizing (~65–100 ticks for these rooms).
- Snakes join only at batch boundaries:
  - first the tickets: deployed bots, in arrival order;
  - then `houseFill` tops the room up to 5 authors, in fill order (medium, easy, hard, chaos,
    then `house:medium#2`, …), with ids `house-<kind>-<tick>-<index in that fill>`.
  - Nobody respawns in the middle of a batch.
- 0–3 of the house bots play as tickets under user names: Better Auth user ids as authors (32
  letters and digits, what `apps/web` gets with no `generateId`), a fresh UUID life id per
  life. After a death they rejoin at the next batch, as a deployed bot's next life would.
- The candidate's ticket arrives after a pre-roll: 100–600 ticks in an older room. A room only
  opens when a ticket joins it, so a young room with no users is one the candidate opened (no
  pre-roll). A young room with users opened with their tickets, and the candidate comes at once
  or after 100–1000 ticks. After each death it rejoins at the next batch. The match is the 1000
  ticks from its first spawn.
- Only the candidate runs in the sandbox, with a fresh `Sandbox` for every `runChecks` call. The
  house bots run natively: they are our own deterministic code. With the candidate alone in the
  sandbox, an OOM can't depend on what other bots do with the shared heap (the sandbox README
  explains how that can happen in a room).
- The bar comes from the same rooms with `easy` in the candidate's seat: same seeds, same rules.
  The opponents then react to a different bot, so the rooms drift apart, but no run is favoured.

`src/room.test.ts` replays each room's trace against RoomDO's planning rules: batch sizes,
batch boundaries, tickets before the fill, exactly `houseFill`'s output at each boundary, and one
snake per author.

### Not recognisable as a check

A bot that knew it was being checked could play like `easy` there and do anything in the arena.
So nothing it can observe is specific to the check (`src/disguise.ts`, `src/room-rules.ts`):

- **Seeds** are the first five 32-bit words of SHA-256(bundle) (`checkSeeds`). Local and server
  agree because the bundle is the same. A bot can't know them, because they depend on its own
  text, so it can't recognise the check by `info.seed` or by its first world. Any edit, even to
  a comment, gives other seeds.
- **Names** are the arena's: UUID life ids and Better Auth user ids for deployed bots (the
  candidate included). House bots get whatever RoomDO's house fill would give them in that room.
- **Time**: rooms open at tick 0 (young rooms) or at any older tick, joins happen only at batch
  boundaries of the arena's size, and the candidate either opens the room or joins it in
  progress.
- **Load**: there is no separate probe life (it used to get `seed: 0`). The load check is the
  candidate's first life in the first match.

`checks.test.ts` runs a bot that checks every invariant of a real room it can see
(`src/testing/invariants.ts`):
- id and author shapes;
- the house kind matching the fill order at its index;
- one author per snake;
- no spawn in the future;
- a whole tick from 0 up, and a life no older than its room.

It runs clean. `invariants.test.ts` shows the same detector catches each tell the check used to
have, including several house bots of one tick all numbered `-0`, UUID user ids, and
(the other way round) a tick range far from 0.

`checks.test.ts` also plays bots keyed on single signs of the arena in a room set up the way
the arena sets one up (`src/testing/arena.ts`: tick 0, Better Auth ids made by Better Auth's own
method) and in the deploy check. A bot that throws on a tick outside the old 50 000–5 010 000
range, or on seeing a Better Auth author, throws in both. A bot that throws on an author the
arena doesn't have, or on any broken invariant, throws in neither.

Still different from a busy room:
- **Room size**: a check room holds 5–6 snakes. Rooms that small exist when few bots are queued.
- **Re-rolling**: since seeds move on every edit, a bot close to the bar can re-roll by
  redeploying. With the full settings, medium and hard passed 8 of 8 bundle variants each
  (medium by 1.1–3.1×, hard by 1.5–9×), while chaos, near the bar, passed 6 of 8.
- **The ports**: `room-rules.ts` must follow RoomDO. `room-rules.test.ts` pins the current
  output, and moving both into a shared package would remove the copy (see the PR).

### A sanity gate, not a perfect disguise

The check stops broken and hopeless bots before they reach the arena. It can't be made
perfectly indistinguishable from the arena, and it doesn't try: its seeds are fixed for a
bundle, the house bots are open source and recognisable by how they play, its rooms are small
(5–6 snakes), and every opponent is a house bot. A determined bot can still guess, from
population signals like these, that it is probably in a check.

The real defence against a bot that behaves differently in the arena is on the arena side:
- ratings (#26): a version is ranked by what it does in real rooms, and re-qualification from
  ratings should drop a version whose rating falls below `easy`'s;
- the room backstop (RoomDO, #56): CPU and slow-tick strikes ban a version in the arena itself;
- bans by hand for bots that abuse the room.

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

The numbers below are from the first version of this suite, on fixed seeds 101–505 in a
simpler room (instant respawns, no pre-roll). Deploys now get per-bundle seeds, so exact scores differ, but the picture is the same.
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

Before #60 the sandbox's per-tick budget only counted QuickJS interrupt polls, which come about
once per ~4,300 loop iterations however long the loop body is: a bot could stay inside 10 "ops"
per tick and still take most of a second per tick. A bot with easy's logic plus an 8-statement
padding loop passed the first version of this suite in 141 s. Since #60 the sandbox charges every
bundle's own code and every native built-in in cost units (≈ 1 ns of CPU each, 10 M per tick by
default) next to the interrupt polls, so the per-tick budget bounds CPU, up to the gaps listed
in the sandbox's README ("Known gaps").

`SuiteBudget` caps the whole suite on top of the per-tick budget:

| cap             | default                                            | deterministic | where it bites                       |
| --------------- | -------------------------------------------------- | ------------- | ------------------------------------ |
| `maxInterrupts` | half the per-tick budget on average over all ticks | yes           | Node and workerd                     |
| `maxWork`       | the same, in cost units                            | yes           | Node and workerd                     |
| `maxMillis`     | 60 s of wall clock, read between ticks and lives   | no            | Node only (workerd's clock is still) |
- A run that hits a cap fails `run` with "too slow" and a hint. `report.run.overrun` names the
  cap, and `report.run.cost` holds the totals.
- The interrupt and work caps are part of the rules: a bot that uses more than half its budget
  on average is rejected, because crowded rooms cost more than these matches.
- The wall clock is the backstop for the sandbox's known gaps: in Node it bounds the suite to
  within one tick past 60 s.
- In workerd `performance.now()` doesn't advance during computation, so the only backstop there
  is the Worker's CPU limit. The consumer (#22) must treat "exceeded CPU" on a check job as a
  rejection ("too slow"), not as a retryable failure.
- The wall-clock cap makes local and server results differ, but only for bots far slower than
  any honest one.

`CostMeter` (`src/cost.ts`) is the only code that reads costs out of a `TickReport`.

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
✗ Runs      killed on seed 443573865 at tick 6 (life 1): 3 ticks in a row over budget
            What to fix: tick() ran longer than its budget (10 ops, a few milliseconds) 3 ticks in a
            row. Look for a loop that never ends, or work that grows with the game: ...
- Qualifies skipped: fix the problems above first

Last log lines before it died (seed 443573865, tick 6):
    tick 0
    ...
```

## Runtime

Whole suite, Node 24, Apple M1 Max, with other work running (`BENCH=1 pnpm vitest run
packages/checks/src/bench.test.ts`):

| bot                                 | time   | result                    |
| ----------------------------------- | ------ | ------------------------- |
| easy / medium / hard                | 2–5 s  | pass                      |
| suicidal                            | 2.0 s  | rejected: qualify         |
| infinite loop                       | 0.07 s | rejected: timeout death   |
| ~80% of the op budget on every tick | 7.7 s  | rejected: `maxInterrupts` |
| easy + 8-statement padding loop     | 0.05 s | rejected: timeout death   |
| easy + 200-statement loop body      | 0.03 s | rejected: timeout death   |

Before #60 the two padding bots stayed within their ops and took 26 s and 60 s (`maxMillis`).

Times vary by bundle, because each bundle gets its own seeds. Honest bots cost the candidate's
5000 sandbox ticks, plus ~0.5 s for the baseline and the house bots (including the pre-roll).
The per-tick budget bounds that time, up to the sandbox's known gaps, for which the Node bound is
the 60 s cap. In workerd, the bound is the consumer's CPU limit: set `limits.cpu_ms` to the
maximum the plan allows (e.g. 300 000) and reject a job that exceeds it.

Process one check job at a time per isolate. Each `runChecks` holds a sandbox with a wasm heap
of up to 64 MiB while it runs. The `Sandbox` has no `dispose()`: every life is disposed, and the
heap is reclaimed by GC once the call has returned and dropped its reference. An explicit
`Sandbox.dispose()` would be a sandbox change.

`src/workerd.test.ts` runs the suite in workerd (Miniflare) with the wasm passed in as a compiled
module, and checks that the reports are identical to Node's. It covers an honest bot and
suicidal, looping, throwing, OOM and export-less bots (2 seeds × 500 ticks), and the full deploy
configuration once (5 hash seeds × 1000 ticks).
