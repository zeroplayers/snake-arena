# My ZeroSnake bot

A bot for [ZeroSnake Arena](https://github.com/zeroplayers/snake-arena): slither.io-style snakes,
each driven by a small JS/TS program, playing each other 24/7 in persistent rooms.

The starter bot in `src/bot.ts` eats the nearest food it can reach and steers clear of bodies and
the wall. It beats the weakest house bot and loses to the rest: make it yours.

## Quick start

> **Today the `@zerosnake/*` packages are not on npm yet**, so `npm install` in a copy of this
> folder fails (`workspace:*` ranges, or `^0.0.0` after `zerosnake init`). Until they are published,
> work in a checkout of the [monorepo](https://github.com/zeroplayers/snake-arena), where this
> folder is `template/` and pnpm links the packages:
>
> ```sh
> git clone https://github.com/zeroplayers/snake-arena && cd snake-arena
> pnpm install
> cd template
> pnpm test            # does the bot load and play without errors, within budget?
> pnpm bench           # how does it score against the house bots?
> ```

Once the packages are published, it becomes:

```sh
npx zerosnake init my-snake && cd my-snake
npm install
npm test             # does the bot load and play without errors, within budget?
npm run bench        # how does it score against the house bots?
```

Below, `npm run x` and `pnpm x` mean the same script.

Then open the folder in Claude Code (`claude`) and describe the snake you want ("make it
aggressive: cut off smaller snakes"). `CLAUDE.md` gives Claude the rules, the API and the limits;
the skills in `.claude/skills/` cover writing a new strategy, debugging deaths and comparing
versions. You can of course write the code yourself: start with `src/bot.ts` and `CLAUDE.md`.

## Commands

| Command                                                  | What it does                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| `npm run typecheck`                                      | Type-check the bot and the tests.                            |
| `npm test`                                               | Smoke test in the real sandbox: loads, 3 matches, no faults. |
| `npm run bench`                                          | 20 local matches vs house bots: score, deaths, ops per tick. |
| `npm run bench -- --deaths 5`                            | Also print the last ticks before 5 deaths.                   |
| `npm run bench -- src/bot.ts .zerosnake/prev/src/bot.ts` | Compare two versions on the same seeds.                      |

The `zerosnake` CLI (in progress) adds a local viewer and the arena:

```sh
npx zerosnake sim       # local match vs house bots, opens the viewer
npx zerosnake test      # the same checks the server runs before accepting a version
npx zerosnake login     # sign in through the browser
npx zerosnake deploy    # bundle src/ and send it to the arena
npx zerosnake logs      # recent lives and causes of death
```

## The rules in one minute

- The arena is a circle. Your snake always moves forward; each tick you choose how hard to turn
  (`turn` from -1 left to 1 right) and whether to `boost` (faster, but burns length).
- Eat food to grow. Length slowly decays, so keep eating.
- Hit another snake's body with your head, or the wall, and you die. Head to head, the shorter snake
  dies. Your own body is harmless.
- You only see what is within a radius of your head.
- A life scores your length summed over every tick you were alive, plus 50 per kill, and ends
  after 10 minutes of game time at most. Your rating is the mean over your recent lives.
- Your code runs in a sandbox with a small per-tick budget: no network, no clock, no `async`.

Details: `CLAUDE.md`.

## Layout

```
src/bot.ts          the bot (deploy bundles src/)
test/               smoke test, bench and the local match runner
CLAUDE.md           rules, API, limits, debugging (for Claude and for you)
AGENTS.md           points other coding agents to CLAUDE.md
.claude/skills/     new-strategy, debug-death, compare-with-previous
```
