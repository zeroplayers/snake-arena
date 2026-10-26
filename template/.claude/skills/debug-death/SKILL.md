---

name: debug-death
description: Find out why the ZeroSnake bot dies (wall, collision, head-on, timeout, error) by replaying the last ticks before its deaths, then fix the cause and show the death rate dropped. Use when the author says the snake dies, crashes, times out, "keeps hitting walls", or asks why a life ended.
---

# Debug a death

Read the "Common causes of death" table in `CLAUDE.md` first; most deaths are one of those.

## 1. Get deaths with context

**Now (local):**

```sh
npm run bench -- --deaths 5 --context 15
```

The table's `deaths` column gives the mix of causes. Each printed death shows seed, tick, cause,
who you hit, then one line per tick before it: head position, angle, length, `wall` distance, the
nearest visible body and its `gap` (free space; 0 = touching), food in view, the action taken,
outcome, interrupts used, and that tick's `log()` lines. Deaths are deterministic: the same code and
seed reproduce them exactly.

Need more detail (every snake's head and angle, the full food list)? Write a throwaway script or
test that calls `playMatch(await bundleBot(), { seed, ticks, opponents })` from `test/match.ts` and
inspect `result.lives[i].trace` (last 30 ticks: the exact `state` the bot got, its `action`,
`outcome`, `error`, `log`).

**Later (arena):** `npx zerosnake logs` lists recent arena lives with causes of death and their
context; arena traces keep the last 100 ticks before each death. With the MCP server connected
(`claude mcp add zerosnake https://<arena-domain>/mcp`), use `list_lives(version, filter: "deaths")`
and then `get_death_context(life)` for what the snake saw, what the bot returned and its logs in the
last ticks. `npx zerosnake sim --seed N` replays a local match in the viewer (jump to death, vision
radius, logs). Use whichever exists; if a command is not available yet, say so and use the bench.

## 2. Diagnose

Work out the mechanism from the numbers, not from the cause label alone:

- **`wall`:** was `wall` shrinking while `turn` was already ±1? Then it turned too late (margin
  too small for the turning radius `speed / turnRate`, or boosting). Was `turn` pointing the wrong
  way? Sign error.
- **`collision`, `gap` shrinking over many ticks:** it saw the body and still drove in: avoidance
  only looked straight ahead, or turned toward another part of the body.
- **`collision`, `gap` large then suddenly 0:** the other snake moved across the path (avoidance
  treats snakes as static), or the body was outside vision / between downsampled points.
- **`collision` with a head (`nearest body` is the other's head):** head-on with a longer or equal
  snake.
- **`timeout`:** look at `ops` in the ticks before; find the loop that scales with `snakes` /
  `food` / segments.
- **`error`:** the `error:` line has the exception. Usually `null` head/angle or an empty array.

Check it on more than one death: fix the most common cause first.

## 3. Fix and prove it

1. Turn the fatal tick into a regression test: copy its `state` from the trace into a test in
   `test/`, run the bot's `tick` on it (or call `playMatch` with that seed) and assert the action is
   safe (e.g. turns away from the wall).
2. Fix the bot. Keep the change minimal and explain the mechanism in a comment if it is not obvious.
3. `npm run typecheck && npm test`, then compare with the version before the fix (skill
   `compare-with-previous`): that death cause should drop and the mean score should not get worse.
   Report the before/after numbers.
