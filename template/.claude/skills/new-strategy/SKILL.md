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
2. `npm run bench` and keep the table: mean score ± error, deaths by cause, max ops. This is the
   number the new strategy has to beat (unless the author explicitly wants a style over a score).

## 2. Design (say it in a few lines before coding)

Pin down, in terms of the real mechanics:

- **Safety layer** (never skip it, whatever the style): wall margin from the turning radius
  (`self.speed / self.turnRate`, doubled while boosting), body avoidance by simulating candidate
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
npm run typecheck && npm test
npm run bench -- src/bot.ts .zerosnake/prev/src/bot.ts   # or just `npm run bench` vs the saved table
npm run bench -- --deaths 5 --context 10                 # look at how it dies now
```

- No `timeout`/`error` lives, `max ops` well under 10 (aim for ≤ 5).
- Mean score clearly above `house:easy` (deploy qualification) and, ideally, above the baseline by
  more than twice the `±`. If it is worse, say so with the numbers and iterate (skill
  `debug-death` on the most common death cause), don't claim success.
- For a style request, also check the style shows up: e.g. an aggressive bot should have kills; add
  a `log("kill attempt", id)` and count, or compare deaths/kills in the replays.

When the CLI is installed, finish with `npx zerosnake test` (exact server checks) and
`npx zerosnake sim --vs easy,hard` to watch it. Report the before/after table to the author.
