# @zerosnake/checks

The deploy checks of SPEC §6. `zerosnake test` runs them in Node, and the version-check Queue
consumer (#22) runs them in workerd. Both get the same report for the same upload.

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

| id        | passes when                                                                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `limits`  | ≤ 50 source files, ≤ 1 MiB of sources, bundle ≤ 256 KiB in UTF-8 (`LIMITS`; the deploy API should import these)                                       |
| `load`    | the bundle loads in the sandbox and default-exports an object with `tick()`; `init()` runs                                                            |
| `run`     | on each of `CHECK_SEEDS` (101, 202, 303, 404, 505), a `CHECK_TICKS` (1000) tick match against easy, medium, hard and chaos ends with no sandbox death |
| `qualify` | mean score per life ≥ that of `easy` in the same seat on the same seeds                                                                               |

`run` follows the sandbox's strike rules. A timeout or an exception on its own costs one tick:
the snake repeats its previous action. These ticks show up as warnings. A death by `timeout`
(3 in a row over budget), `error` (3 throws in a row, or `init()` throwing on a respawn) or `oom`
fails the check. The suite stops at the first such death and reports its seed, tick, life, the
sandbox's message and the bot's last 20 log lines.

### Matches

- Default engine config. The lineup is the candidate plus `OPPONENTS` (easy, medium, hard,
  chaos). Every seat respawns as soon as it dies, except on the last tick.
- Only the candidate runs in the sandbox, with a fresh `Sandbox` for every `runChecks` call. The
  house bots run natively: they are our own deterministic code. With the candidate alone in the
  sandbox, an OOM can't depend on what other bots do with the shared heap (the sandbox README
  explains how that can happen in a room).
- The bar comes from the same matches with `easy` in the candidate's seat. That makes it a paired
  comparison: same seeds, same opponents, same spawn order. The bar doesn't depend on the
  candidate, so it is computed once per isolate and cached.

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
window. Those bots rank badly per life. Per slot, `easy` collects ~470 over the five seeds (16
lives) and `chaos` ~170 (6 lives). Per life, `chaos` comes close to `easy` (27.7 vs 29.5).

A reviewer of #48 noted that **medium beats hard per life but not per slot**, and these matches
show the same: per life, medium scores 105.9 and hard 104.0. Hard collects more kills, but it
dies more often while hunting (9 lives against medium's 6). Under the arena's rating, hard would
therefore not rank above medium. That's a tuning question for the house bots (#10) and rating
(#26), not for this gate. The gate only compares a bot with `easy`, and every honest house bot
clears that comfortably (medium and hard both score ~3.5× easy).

Results on the default seeds (mean score per life, lives in brackets):

| bot                           | score                      | verdict              |
| ----------------------------- | -------------------------- | -------------------- |
| easy (the bar)                | 29.5 (16)                  | passes: a tie passes |
| medium                        | 105.9 (6)                  | passes               |
| hard                          | 104.0 (9)                  | passes               |
| chaos                         | 27.7 (6)                   | rejected             |
| drives straight on (suicidal) | 1.2 (55, 40 into the wall) | rejected             |
| circles on the spot           | 4.4 (13)                   | rejected             |

`chaos` misses the bar, which is fine: it is a random sparring partner, not a ranked bot.

## Report

`CheckReport` is plain JSON and a pure function of the input. It holds no timings and no
randomness. `version` (`REPORT_VERSION`) changes when its shape does. Every check has `status`,
a one-line `summary` and a `hint` (what to fix, when it failed), plus its own details: limit
problems and the largest files, the load error, the fault with log lines, per-seed lives and
causes of death, the scores per seed. Messages are in the JSON as the sandbox wrote them,
stacks included. Summaries keep only the first line and where the error was thrown in
`bot.js`.

`formatReport` renders it for a person:

```text
Checks failed: this bot would be rejected.

✓ Limits    1 source file, 131 B of source, bundle 131 B
✓ Loads     the bundle loads and default-exports a bot with tick()
✗ Runs      killed on seed 101 at tick 6 (life 1): 3 ticks in a row over budget
            What to fix: tick() ran longer than its budget (10 ops, a few milliseconds) 3 ticks in a
            row. Look for a loop that never ends, or work that grows with the game: ...
- Qualifies skipped: fix the problems above first

Last log lines before it died (seed 101, tick 6):
    tick 0
    ...
```

## Runtime

Whole suite, Node 24, Apple M1 Max, with other work running (`BENCH=1 pnpm vitest run
packages/checks/src/bench.test.ts`):

| bot                                 | time                  |
| ----------------------------------- | --------------------- |
| easy / medium / hard                | 1.1 s / 1.8 s / 4.5 s |
| suicidal (55 lives)                 | 1.3 s                 |
| infinite loop                       | 0.02 s                |
| ~90% of the op budget on every tick | 14 s                  |

The cost is mostly the candidate's 5000 sandbox ticks. The baseline and the house bots take
~0.3 s. A bot can't spend much more than 5000 × `opBudget` interrupts in total (one over-budget
tick ends one interrupt past the budget, and three in a row kill the snake), so ~15 s on this
machine is the ceiling for a bot that passes. Bots that fail stop early.

In workerd the consumer needs a CPU limit above that ceiling. Set `limits.cpu_ms` well over 15 s
(e.g. 60 000) in its wrangler config. The default 30 s is cutting it close on slower hosts.

`src/workerd.test.ts` runs the suite in workerd (Miniflare) with the wasm passed in as a compiled
module, and checks that the reports for an honest bot and for suicidal, looping, throwing,
OOM and export-less bots are identical to Node's.
