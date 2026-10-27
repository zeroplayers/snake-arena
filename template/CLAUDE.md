# ZeroSnake bot

This repo is one bot for **ZeroSnake Arena**: slither.io-style snakes, each driven by a small JS/TS
program, playing each other around the clock in persistent rooms. Your job is to help the author
write and improve the bot in `src/`. The author describes the strategy; you write the code, test it
locally and check that it really is better before they deploy.

Everything below matches `@zerosnake/sdk`, `@zerosnake/sandbox` and the engine's default config. If
something here disagrees with the SDK's types, the types win: `vendor/zerosnake-sdk/src/` in a
project made by `zerosnake init` (also linked as `node_modules/@zerosnake/sdk` after `npm install`),
`packages/sdk/src/` in the monorepo.

## Setup

The `@zerosnake/*` packages are not on npm yet, so this folder is one of two things:

- **A project made by `npx zerosnake init`** (the usual case). `init` copies the SDK into
  `vendor/zerosnake-sdk` and points `@zerosnake/sdk` at it, so `npm install` works and editors see
  the types. The `zerosnake` CLI does the rest: `sim`, `test`, `deploy` (see "Testing, debugging and
  deploying"). Type-check the bot with `npx tsc -p .`. `test/` (`npm test`, `npm run bench`,
  `npm run typecheck`) needs the engine, sandbox and house bots, which `init` leaves out: those
  scripts fail here. Don't try to make them work (no `package.json` edits, extra installs or
  replacing `vendor/zerosnake-sdk`); use the CLI.
- **`template/` inside a checkout of the `zeroplayers/snake-arena` monorepo**, after `pnpm install`
  at the repo root. Everything works, including the scripts in `test/` (`pnpm test` or `npm test`,
  same thing), and the CLI is `node ../packages/cli/bin/zerosnake.js` (after
  `pnpm --filter zerosnake build`).

Until the `zerosnake` package is on npm, `npx zerosnake` may not resolve; the author then runs the
CLI from a monorepo checkout as `node <checkout>/packages/cli/bin/zerosnake.js` (ask for the path
and use it wherever this file says `npx zerosnake`). If there is no CLI at all, say so; never invent
CLI output.

## Files

| Path               | What                                                                         |
| ------------------ | ---------------------------------------------------------------------------- |
| `src/bot.ts`       | The bot. Must `export default defineBot({ init, tick })`. Deploy bundles it. |
| `src/*.ts`         | Split code into more files if you like; import them with `./x.ts`.           |
| `test/bot.test.ts` | Smoke test: the bot loads in the real sandbox and plays without faults. ¹    |
| `test/bench.ts`    | `npm run bench`: local matches vs house bots, scores, death replays. ¹       |
| `test/match.ts`    | The match runner both use (real engine + real sandbox). ¹                    |
| `vendor/`          | The SDK, copied by `zerosnake init` until it is on npm. Don't edit it.       |
| `.claude/skills/`  | `new-strategy`, `debug-death`, `compare-with-previous`.                      |

¹ Only in the monorepo checkout (see Setup); in an `init` project use the CLI instead.

Only `src/` is deployed. Keep tests and tools out of it.

## Rules you must follow

1. `src/bot.ts` default-exports `defineBot(...)` from `@zerosnake/sdk`. The only imports allowed are
   `@zerosnake/sdk` and your own relative files: no npm packages that use Node, the DOM or I/O.
2. No `async`/`await`, `Promise` chains, `Date`, `performance`, `setTimeout`/`setInterval`, `fetch`,
   `import()`, `eval`/`new Function`, `Proxy`, `BigInt`, `WeakRef`. They are missing or blocked in
   the sandbox. The word `async` or a BigInt literal like `10n` **anywhere** in the bundle (even in a
   string or comment) gets it rejected at load.
3. Stay inside the per-tick budget (below). Never loop without a bound.
4. Never hard-code speeds, radii, turn rate or arena size: read them from `info` and `state.self`.
   The values in this file are today's defaults and may be tuned.
5. Before saying a change is done: `npx tsc -p .` (type-checks `src/`) and `npx zerosnake test` (the
   server's checks), then compare with the previous version (skill `compare-with-previous`). In the
   monorepo checkout, `npm run typecheck && npm test` and `npm run bench` work too.

## The game

- **Arena:** a square centred on (0, 0): `x` and `y` both lie in ±`info.worldHalfSize` (default
  89). Your head crossing an edge is death by `wall`. The corners are traps: heading into one you
  have two walls ahead, so keep well clear of them, and to leave a wall turn straight away from it
  (`nearestWall(head, info.worldHalfSize).normal`), not toward the centre.
- **Time:** fixed ticks, `info.tickRate` (10) per second of game time. Rooms without spectators run
  faster than real time; nothing depends on wall-clock time.
- **Movement:** every tick the snake turns by up to `self.turnRate` radians (0.25), then moves
  `self.speed` units (1.5) forward. It never stops. The tightest circle it can drive has radius
  `speed / turnRate` (6 units; 12 while boosting, because boosting doubles speed but not turn rate).
  A U-turn needs about twice that much room.
- **Boost:** `boost: true` doubles speed (to 3) and burns 1 length per tick, dropped as food behind
  your tail. Refused below length 5. It is expensive: you start at length 10.
- **Length** (`self.length`, the engine's "mass") grows by eating food and decays every tick from
  hunger: `0.002 + 0.03% of length` (at length 100 that is ~0.03 per tick; at 1000, 0.3). Big
  snakes must keep eating. Body thickness grows slowly with length (`radius` 0.5 → 2.5 at length
  10 000), and so does the number of body points.
- **Food:** pellets worth `value` length. Ambient pellets are worth 1; a dead snake's body turns into
  pellets worth up to 10 each. You eat a pellet when your head comes within about three body
  widths of it (`6 × radius` plus the pellet's size) **and** it is within ±60° of your heading:
  food beside or behind you is not eaten.
- **Deaths:**
  - your head touches another snake's body → `collision`, and the kill goes to that snake;
  - two heads touch → the shorter snake dies (kill to the longer one); equal length, both die;
  - head crosses an arena edge → `wall`;
  - over the op budget 3 ticks in a row → `timeout`; throwing 3 ticks in a row, or running out of
    memory → `error`;
  - at load: module evaluation + `init()` over their 100-interrupt budget → `timeout` before the
    first tick; throwing there → `error`.
  - Your own body is harmless: you cannot hit yourself.
  - Collisions are swept along the move: a fast head cannot jump through a thin body.
  - A dead snake drops its whole length as food.
- **Life cap:** after `info.maxLifeTicks` (6000 ticks = 10 min) the snake retires with its score.
- **Score of a life:** `0.001 × (sum of your length over every tick alive) + 50 × kills`. So: get
  long, stay long, stay alive; a kill is worth as much as holding length 50 for 1000 ticks.
- **Arena:** rooms of 10–20 snakes from different authors (house bots fill gaps). When your snake
  dies, its next life queues for a room. A version's rating is its mean life score over its last
  200 lives (shown after 30). A deploy must out-score the `easy` house bot to be accepted.

## Coordinates and turning (get this right)

- `x` grows east (right), **`y` grows north (up)**, like maths, not like screens.
- Angles are radians, **counter-clockwise** from +x: `0` east, `π/2` north, `-π/2` south, `π` west.
  Angles in state are normalised to (-π, π]. `Math.atan2(dy, dx)` is the heading to a point.
- **`turn > 0` turns right (clockwise, the angle decreases); `turn < 0` turns left.** The engine
  first clamps `turn` to [-1, 1] (`NaN` = 0) and rounds it to the nearest multiple of 1/128, then
  does `angle -= rounded * turnRate`. Look-ahead code that wants to match the engine exactly should
  round the same way: `Math.round(turn * 128) / 128`.
- `angleDiff(from, to)` is positive when `to` is to your **left**, the opposite sign of `turn`. Do not
  convert by hand: use `turnToward(self, angle)`, `steerToward(self, point)`, `steerAway(self, point)`.
- Compare angles with `angleDiff`, never with `a - b` (breaks across ±π).

## Bot API

```ts
import { defineBot, nearestFood, steerToward } from "@zerosnake/sdk";

export default defineBot({
  init(info) {
    // Once per life, before the first tick. What you return is `mem`.
    return { mode: "farm" as "farm" | "flee", target: null as { x: number; y: number } | null };
  },
  tick(state, mem, log) {
    // Every tick. Return the action; mutate `mem` to remember things.
    const food = nearestFood(state);
    log("food", food?.x, food?.y);
    return { turn: food ? steerToward(state.self, food) : 0, boost: false };
  },
});
```

- **Memory:** `mem` (and any module-level variable) lives inside the sandbox for the whole life, so
  it can hold anything (arrays, Maps, class instances). It is reset between lives: each life gets a
  fresh sandbox, `init` runs again. `state` is a fresh copy every tick: copy what you want to keep.
- **`log(...args)`:** like `console.log` (strings as-is, the rest as JSON), one line per call, at most
  `info.logLimitBytes` (1024) bytes per tick; the line that crosses the limit is cut with `…` and
  later calls that tick are dropped. `console.log` goes to the same place. Logs appear in the
  `zerosnake sim` viewer (not in `--headless` output), in the `zerosnake test` report of a bot that
  times out or throws, in bench death replays (monorepo) and in arena traces. Log decisions, not
  whole states.
- **`Math.random()`** works and is seeded per life (`info.seed`), so runs are reproducible.
- **Throwing:** the tick's action is replaced by your previous one; three throws in a row kill you.

`init(info)` gets `BotInfo`: `snakeId`, `worldHalfSize` (89), `visionRadius` (40), `tickRate` (10),
`maxLifeTicks` (6000), `opBudget` (10), `logLimitBytes` (1024), `seed`.

`tick(state, ...)` gets `BotState`:

| Field          | Meaning                                                                         |
| -------------- | ------------------------------------------------------------------------------- |
| `tick`         | Room tick (keeps counting across lives).                                        |
| `lifeTick`     | Ticks since this life started; `0` on the first call.                           |
| `wallDistance` | Distance to the nearest edge: `worldHalfSize - max(\|x\|, \|y\|)`. Below 0: dead. |
| `self`         | Your snake, always fully known (see below).                                     |
| `snakes[]`     | Other snakes with at least one body point within `visionRadius`, nearest first. |
| `food[]`       | Pellets `{ x, y, value }` within `visionRadius`, nearest first.                 |

`self` (`SelfState`): `id`, `head`, `angle`, `length`, `speed` (distance moved last tick), `radius`,
`turnRate`, `boosting`, `segments` (head first, `segments[0]` is the head).

Each of `snakes[]` (`SnakeView`): `id`, `author` (`"house"` for house bots), `length` (full length,
even if only part is visible), `radius`, `head` and `angle` (**`null` when the head is out of
vision**), `boosting`, `segments` (only visible body points, head to tail, never empty).

What you see is capped to keep state small: the 32 nearest snakes, 256 body points over all of them
(far parts of bodies are dropped first), 128 nearest food pellets, 128 points of your own body.
Body points can be **downsampled and non-contiguous**: the gap between two listed points is not
necessarily empty. Treat each point as a circle of that snake's `radius`, and two consecutive points
of one body that are a few units apart as solid between them (points far apart are where the body
left your vision and came back).

Return `BotAction`: `{ turn: number in [-1, 1], boost?: boolean }`. Out-of-range turns are clamped,
`NaN` counts as 0.

### SDK helpers (`@zerosnake/sdk`)

| Helper                                       | Does                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `steerToward(self, point)`                   | `turn` that heads toward a point, as fast as allowed, no overshoot.                                                             |
| `steerAway(self, point)`                     | `turn` that heads directly away from a point.                                                                                   |
| `turnToward(self, angle)`                    | `turn` that reaches a heading.                                                                                                  |
| `angleTo(from, to)`                          | Heading from one point to another.                                                                                              |
| `angleDiff(from, to)`                        | Signed smallest rotation, positive = left.                                                                                      |
| `normalizeAngle(a)`                          | Wraps into (-π, π].                                                                                                             |
| `distance(a, b)`, `distanceSq(a, b)`         | Distances (`distanceSq` is cheaper for comparisons).                                                                            |
| `project(origin, angle, dist)`               | The point `dist` ahead along a heading: look-ahead.                                                                             |
| `distanceToWall(point, worldHalfSize)`       | Distance from any point to the nearest edge (negative outside).                                                                 |
| `nearestWall(point, worldHalfSize)`          | `{ distance, normal }`: the nearest edge and the unit vector pointing away from it, into the arena.                              |
| `distanceToWallAlong(point, angle, half)`    | How far `point` can go straight along `angle` before crossing an edge: the road left, corners included.                         |
| `nearest(from, items)`, `nearestFood(state)` | Closest point / pellet.                                                                                                         |
| `nearestDanger(state)`                       | Closest visible body point of another snake: `{ snake, point, distance, gap }`; `gap` = free space, 0 = dead. Ignores the wall. |
| `clamp`, `TAU`, `CENTER`                     | Small utilities; `CENTER` is (0, 0).                                                                                            |

## Limits

| Limit                | Value                                       | Over it                                                                 |
| -------------------- | ------------------------------------------- | ----------------------------------------------------------------------- |
| Per-tick budget      | `info.opBudget` = **10** interrupts         | Previous action reused + a strike; 3 in a row → `timeout`.              |
| Native work per tick | `opBudget × 1 000 000` units (~10 ms)       | Same as above.                                                          |
| Load + `init()`      | 100 interrupts                              | Dead before the first tick: `timeout` (over budget) or `error` (threw). |
| Memory per bot       | 8 MiB (checked every 10 ticks)              | `error` (oom), at once.                                                 |
| Array length         | 100 000 for built-in array methods          | `RangeError` (counts as a throw).                                       |
| Stack                | 256 KiB                                     | Deep recursion throws.                                                  |
| Log                  | 1024 bytes per tick                         | Truncated, never fatal.                                                 |
| Average per tick     | at most half of `opBudget` (5 interrupts)   | Deploy rejected (measured over the deploy checks' matches).             |
| Deploy               | ≤ 50 files, sources ≤ 1 MB, bundle ≤ 256 KB | Deploy rejected.                                                        |

An interrupt is QuickJS checking in, about every 10 000 bytecode branches or calls. Built-ins that
loop internally (`sort`, `map`, `JSON.stringify`, `split`, Set/Map iteration, ...) are charged by
the size of their input. The template bot uses 0–2 of 10. Rough guide: a few tens of thousands of
distance checks per tick is fine; nested loops over every body point × every food × every
candidate move is not. Precompute once per tick, filter by distance before inner loops, prefer
`distanceSq`, avoid sorting big arrays and `JSON.stringify(state)` every tick.

## Common causes of death

| Symptom (in a death replay)                                       | Likely cause                                                                                                      | Fix                                                                                                       |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `wall`, turning hard the last few ticks                           | Started turning back too late                                                                                     | Turn away when `wallDistance` < ~3 turning radii (`speed / turnRate`); more while boosting.               |
| `wall` in a corner                                                | Two walls ahead; the turn out needs far more room than at a straight wall                                         | Keep out of the corners (treat them as rounded off to 3–4 turning radii); check the road with feelers.    |
| `wall` while turning toward the centre                            | The shorter turn toward the centre swung the head through the wall first (off the axes)                           | Turn toward `nearestWall(...).normal`, straight away from the wall.                                       |
| `wall` while chasing food near the edge                           | Food target overrides safety                                                                                      | Check safety after choosing a target, not before.                                                         |
| Snake turns away from food / spins / hugs the wall                | `turn` sign flipped                                                                                               | Use `steerToward`/`turnToward`; `turn > 0` is right.                                                      |
| Circles one pellet forever, starves                               | Pellet inside the turning circle                                                                                  | Skip food that would need a tighter circle than `speed / turnRate` (see `bestFood` in `src/bot.ts`).      |
| `collision` with a body that was in view for many ticks           | Steered away from the nearest point into another part of the body, or only checked straight ahead                 | Simulate a few candidate turns several ticks ahead and check every nearby point (the template's feelers). |
| `collision` with a body that was moving across your path          | Treated other snakes as static                                                                                    | Project other heads forward (`project(head, angle, speed × t)`), keep a bigger margin near heads.         |
| `collision` with something that "wasn't there"                    | Body outside vision or between downsampled points                                                                 | Assume bodies are solid between listed points; slow down your risk near the vision edge.                  |
| Head-on `collision`                                               | Met a longer (or equal) snake head first                                                                          | Only go head-to-head with clearly shorter snakes; dodge heads of others.                                  |
| `collision` right after boosting                                  | Boost doubled the turning radius                                                                                  | Don't boost near bodies or the wall; boost in short bursts.                                               |
| Length melts away, low score without dying                        | Boosting too much, or hunger with no food                                                                         | Boost only when it buys a kill or escape; always keep eating.                                             |
| `timeout`                                                         | Too much work in one tick                                                                                         | See Limits; check `max … ops per tick` in `zerosnake sim --headless`.                                     |
| `timeout` after 0 life ticks, error "... went over its op budget" | Heavy precomputation at module load or in `init()` (lookup tables, big arrays) over the 100-interrupt load budget | Precompute less, or spread it over the first ticks (keep progress in `mem`).                              |
| `error`                                                           | An exception, e.g. `snake.head.x` when `head` is `null`, `arr[0]` on an empty array, a deep recursion             | Handle `null`/empty cases (the types force you to with `noUncheckedIndexedAccess`).                       |

## Testing, debugging and deploying

```sh
npx tsc -p .                                     # type-check src/: no Node/DOM types, so setTimeout, fetch, process fail (Date, Promise don't: avoid them anyway)
npx zerosnake sim --headless                     # one local match vs easy, medium, hard, chaos: score, kills, deaths, max ops per tick
npx zerosnake sim --headless --seed 7 --vs hard,hard,./.zerosnake/prev/src/bot.ts   # pick the seed and the opponents
npx zerosnake test                               # the exact checks the server runs on deploy (exit 0 pass, 1 fail)
npx zerosnake test --json                        # the same report as JSON on stdout
npx zerosnake login                              # browser device flow, once
npx zerosnake deploy -m "what changed"           # runs test here, uploads, waits for the server's checks
npx zerosnake status                             # your bots: active version, rating, lives, deploys left today
npx zerosnake logs                               # a version's check report and recent lives
npx zerosnake logs --deaths                      # recent arena deaths, last ticks before each (saw, returned, cost, logs)
```

- **Never run plain `npx zerosnake sim` yourself:** it opens the viewer in a browser and waits until
  it is closed. Always pass `--headless`. Suggest the plain command to the author when watching a
  match helps (it shows vision, logs and lets them jump to deaths); the headless summary ends with
  the exact command to watch that match.
- `sim --headless` plays one seed (random unless `--seed`, printed so you can repeat it) and exits 1
  if the sandbox killed your bot. A single match is noisy: compare versions over many seeds (skill
  `compare-with-previous`). It doesn't print `log()` lines or what the bot saw before a death; for
  that, ask the author to watch the match, or use the bench in the monorepo.
- Same code + same seed + same opponents = the same match, so a death reproduces exactly.

### What `zerosnake test` (and `deploy`) check

The bundle within the deploy limits; it loads in QuickJS and exports `tick`; 5 matches × 1000 ticks
against the house bots with no timeouts, exceptions or out-of-memory and on average at most half the
per-tick budget; and qualification: a mean score per life at least that of the `easy` house bot
put in your seat on the same seeds. A failing report says what to fix. `deploy` runs the same checks
before uploading: a bot that fails isn't uploaded and costs no deploy.

- **The seeds come from the bundle's hash.** The server judges the bundle `deploy` uploads, so it
  plays the same seeds as your `test` and reaches the same verdict. The same code bundles to the
  same bytes in any folder or machine with the same CLI version. Any change to the code gives other
  seeds; comments (all of them, `/*!` and `@license` ones too) and formatting don't: the bundle
  drops them.
- **Keep a margin over `easy`.** easy's own score swings a lot from one set of seeds to the next
  (it dies often, and now and then has a long lucky life with kills), so a bot close to easy's
  score can pass on one version and fail on the next, by luck of the seeds. The starter bot scores
  about 4.6× easy's mean score per life on typical seeds and at least 1.5× on about 99% of seed
  sets, but even it failed 1 of the 3600 seed sets we measured (easy got kills there): aim for a
  margin like that. One passing `test` doesn't prove a bot is good enough: if a pass is narrow
  (look at "mean score per life … easy in your seat" seed by seed), make the bot clearly better,
  e.g. fewer early deaths, rather than re-rolling seeds.
- **Usually a few seconds.** `test` warns when the checks take 20 s or more: the server runs them
  under a CPU time limit, possibly on a slower machine, so a slow bot can pass here and still be
  rejected there ("the checks didn't finish"). Make the ticks cheaper.

### Bench (monorepo checkout only)

```sh
npm run typecheck     # the bot and the tests
npm test              # smoke test: loads in the real sandbox, 3 matches vs house bots, no faults, budget headroom
npm run bench         # 20 seeds × 3000 ticks vs house bots: mean life score ± error, deaths by cause, max ops
npm run bench -- --deaths 5 --context 15     # also replay the last 15 ticks before 5 deaths
npm run bench -- src/bot.ts .zerosnake/prev/src/bot.ts   # compare two versions on the same seeds
```

The bench runs the real engine and your bundled bot in the real sandbox with the arena's budget,
so what passes here behaves the same in the arena (only the opponents differ). Results are
deterministic: the same code and seeds always give the same numbers. To pin a bug down, copy the
`state` of the fatal tick from a death replay into a unit test and assert that your bot's action is
safe. `test/match.ts` exposes `playMatch`, whose lives carry a `trace` of the last 30 ticks (state,
action, logs).

Later, an MCP server (`claude mcp add zerosnake https://<arena-domain>/mcp`) will let you inspect
arena lives directly: `list_bots`, `list_versions`, `list_lives(version, filter)`,
`get_death_context(life)`, `compare_versions(a, b)`, `get_leaderboard`.

House bots, for calibration: `easy` (nearest food, ignores snakes: the qualification bar),
`medium` (best-value food, avoids bodies and heads), `hard` (`medium` plus hunting shorter snakes
with boosted cut-offs), `chaos` (random but not suicidal).
