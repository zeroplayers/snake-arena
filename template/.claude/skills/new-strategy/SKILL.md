---

name: new-strategy
description: Design and implement a new strategy for the ZeroSnake bot in src/ (e.g. "make it aggressive", "farm safely", "hunt small snakes"), then prove it loads, stays in budget and scores better than before. Use when the author asks for a new behaviour, a rewrite, or a different play style.
---

# New strategy

Goal: a bot that does what the author asked **and** still passes the deploy checks (no exceptions,
no timeouts, mean life score at least the `easy` house bot's). Read `CLAUDE.md` first if you have not
this session: rules, API, coordinate convention and limits are there.

## 1. Baseline

1. Make sure the current version is committed (`git status`); if not, ask before committing, or
   copy it aside: `mkdir -p .zerosnake/prev && cp -r src .zerosnake/prev/`.
2. Measure it on a fixed set of seeds and keep the numbers (step 2 of skill
   `compare-with-previous`: `npx zerosnake sim --headless --seed N` for N = 1…20; in the monorepo,
   `npm run bench`): pts/min and mean score ± error, deaths by cause, max ops. This is what the new strategy has
   to beat (unless the author explicitly wants a style over a score).

## 2. Design (say it in a few lines before coding)

Pin down, in terms of the real mechanics:

- **Safety layer** (never skip it, whatever the style): wall margin from the turning radius
  (`self.speed / self.turnRate`, doubled while boosting) and a bigger one in the square's corners,
  body avoidance by simulating candidate
  turns a few ticks ahead (see `safeTicks` in the template), extra margin around heads of snakes
  as long as or longer than you.
- **Food:** which pellets (nearest reachable, best value per distance, remains of dead snakes are
  worth up to 10).
- **Style-specific behaviour**, e.g. for an _aggressive_ bot:
  - kills are worth 50 score each and come from other snakes hitting **your body**. Cut-offs: get
    your head ahead of a shorter snake's head and turn across its path so it runs into you;
    circling a shorter snake works too.
  - head-to-head only against clearly shorter snakes (equal length: both die);
  - boost in short bursts only to close a cut-off (boost costs 1 length per tick and doubles your
    turning radius); never boost below ~length 30 or near the wall;
  - fall back to farming when no target is in vision: a dead or starving hunter scores nothing.
- **Memory** (`mem`): what must persist between ticks (current target id, mode, ticks in mode).
  Remember a target by `id`; re-find it in `state.snakes` each tick (it may leave vision).
- **Budget:** estimate the work per tick (candidates × look-ahead × nearby points). Filter points
  by distance once per tick before inner loops.

## 3. Implement

- Keep `src/bot.ts` the entry with the default export; split helpers into `src/*.ts` if it grows.
- Read every constant from `info` / `state.self`; name tunables as `const` at the top.
- Handle `head === null` / `angle === null` for other snakes and empty arrays.
- `log()` mode changes and key decisions (target id, why it bailed out), not whole states.

## 4. Verify

```sh
npx tsc -p .                 # type-check src/
npx zerosnake test           # the server's deploy checks: must pass
npx zerosnake sim --headless --seed 1    # quick look: score, kills, deaths by cause, max ops
```

Then compare with the baseline on the same seeds (skill `compare-with-previous`). In the monorepo
checkout, `npm run typecheck && npm test`, `npm run bench -- src/bot.ts .zerosnake/prev/src/bot.ts`
and `npm run bench -- --deaths 5 --context 10` do the same with more detail.

- `zerosnake test` passes: no `timeout`/`error`, at most half the budget on average, and a mean
  score per life above `easy` in your seat. Look at the margin seed by seed: a narrow pass can turn
  into a fail on the next edit (the seeds come from the bundle's hash), so make it clear, not lucky.
  If `test` warns that the checks were slow, cut the work per tick.
- `max … ops per tick` well under 10 (aim for ≤ 5).
- Points per minute (the rating) above the baseline by more than twice the `±`. If it is worse, say so with the numbers
  and iterate (skill `debug-death` on the most common death cause); don't claim success.
- For a style request, also check the style shows up: e.g. an aggressive bot should have kills
  (the `kills` column of `sim --headless`); compare kills and deaths with the baseline.

Report the before/after table to the author, and suggest `npx zerosnake sim --vs easy,hard` to
watch it (it opens the viewer and waits, so let the author run it) and `npx zerosnake deploy`.
