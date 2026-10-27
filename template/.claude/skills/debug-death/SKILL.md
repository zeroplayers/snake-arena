---

name: debug-death
description: Find out why the ZeroSnake bot dies (wall, collision, head-on, timeout, error) by replaying the last ticks before its deaths, then fix the cause and show the death rate dropped. Use when the author says the snake dies, crashes, times out, "keeps hitting walls", or asks why a life ended.
---

# Debug a death

Read the "Common causes of death" table in `CLAUDE.md` first; most deaths are one of those.

## 1. Get deaths with context

**Local, with the CLI:**

```sh
npx zerosnake sim --headless --seed 1      # repeat with other seeds
```

The `deaths` column gives the mix of causes; the lives list says when each life ended and who it
ran into (`ticks 154–1129, score 155, ran into hard#1`). Same seed, same opponents, same code: the
same deaths. The headless summary has no per-tick context or `log()` lines: for those, ask the
author to watch the match (`npx zerosnake sim --seed N`, the command the summary ends with: jump to
a death, vision radius, logs; it opens the browser and waits, so don't run it yourself). A bot that
times out or throws shows the error and its last logs in `npx zerosnake test`'s report.

**Local, in the monorepo checkout:**

```sh
npm run bench -- --deaths 5 --context 15
```

The table's `deaths` column gives the mix of causes. Each printed death shows seed, tick, cause,
who you hit, then one line per tick before it: head position, angle, length, `wall` distance, the
nearest visible point of another snake (`nearest hard-3 body gap 1.1`, or
`nearest hard-3 HEAD (length 209.7) gap 1.1` when that point is its head; `gap` is free space,
0 = touching), food in view, the action taken, outcome, interrupts used, and that tick's `log()`
lines. Deaths are deterministic: the same code, seed, tick count and lineup reproduce them exactly.

Need more detail (every snake's head and angle, the full food list)? Write a throwaway script or
test that replays the bench match and inspects `result.lives[i].trace` (last 30 ticks: the exact
`state` the bot got, its `action`, `outcome`, `error`, `log`):

```ts
import { BENCH_LINEUP, bundleBot, playMatch } from "./match.ts";

// Same seed, ticks (bench default 3000) and lineup as the bench, so the same deaths happen.
const result = await playMatch(await bundleBot(), {
  seed: 2,
  ticks: 3000,
  opponents: BENCH_LINEUP,
});
const death = result.lives.find((l) => l.tick === 483);
```

Another lineup or tick count is a different match: the death will not be there.

**Arena:** `npx zerosnake logs --deaths` lists recent arena deaths and prints the death context
of the latest 3: for each of the last ticks (`--context 30` for more, up to 100), what the snake
saw (head, wall distance, nearest snake with its gap, food), what the bot returned, what it cost
and what it logged, plus errors, timeouts and whether the room restarted the bot. `npx zerosnake
logs --life <id>` shows one life (an id from the list, or its replay URL). Traces are kept 7 days.
The arena's opponents are other people's bots, so an arena death usually can't be replayed
locally: reason from the trace, then write a unit test with a similar state. Later, with the MCP
server connected (`claude mcp add zerosnake https://<arena-domain>/mcp`), `get_death_context(life)`
will give the same. If a command is not available yet, say so; don't invent its output.

## 2. Diagnose

Work out the mechanism from the numbers, not from the cause label alone:

- **`wall`:** was `wall` shrinking while `turn` was already ±1? Then it turned too late (margin
  too small for the turning radius `speed / turnRate`, or boosting). Was `turn` pointing the wrong
  way? Sign error.
- **`collision`, `gap` shrinking over many ticks:** it saw the body and still drove in: avoidance
  only looked straight ahead, or turned toward another part of the body.
- **`collision`, `gap` large then suddenly 0:** the other snake moved across the path (avoidance
  treats snakes as static), or the body was outside vision / between downsampled points.
- **`collision` with `HEAD` as the nearest point in the last ticks:** head-on with a longer or
  equal snake (compare its length with yours).
- **`timeout` during play:** look at `ops` in the ticks before; find the loop that scales with
  `snakes` / `food` / segments.
- **`timeout` after 0 ticks, error "... went over its op budget":** module evaluation plus `init()`
  ran over their 100-interrupt load budget. Look for heavy precomputation at the top level or in
  `init()` (lookup tables, big arrays, warm-up loops). Shrink it or spread it over the first ticks
  with progress kept in `mem`. A throw at load gives `error` after 0 ticks instead.
- **`error`:** the `error:` line has the exception. Usually `null` head/angle or an empty array.

Check it on more than one death: fix the most common cause first.

## 3. Fix and prove it

1. In the monorepo checkout, turn the fatal tick into a regression test: copy its `state` from the
   trace into a test in `test/`, run the bot's `tick` on it (or replay the bench match as above)
   and assert the action is safe (e.g. turns away from the wall). With the CLI only, note the seeds
   and ticks of the deaths you are fixing and re-run those seeds after the fix.
2. Fix the bot. Keep the change minimal and explain the mechanism in a comment if it is not obvious.
3. `npx tsc -p .` and `npx zerosnake test`, then compare with the version before the fix (skill
   `compare-with-previous`): that death cause should drop and the mean score should not get worse.
   Report the before/after numbers.
