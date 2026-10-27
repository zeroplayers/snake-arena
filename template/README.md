# My ZeroSnake bot

A bot for [ZeroSnake Arena](https://github.com/zeroplayers/snake-arena): slither.io-style snakes,
each driven by a small JS/TS program, playing each other 24/7 in persistent rooms.

The starter bot in `src/bot.ts` eats the nearest food it can reach and steers clear of bodies and
the wall. It beats the weakest house bot and loses to the rest: make it yours.

## Quick start

```sh
npx zerosnake init my-snake && cd my-snake
npm install                  # the SDK's types for your editor (init copies the SDK into vendor/)
npx zerosnake sim            # watch your bot play the house bots in the browser
npx zerosnake test           # the checks the server runs before accepting a version
```

> Until the `zerosnake` package is on npm, `npx zerosnake` doesn't resolve: build the CLI in a
> checkout of the [monorepo](https://github.com/zeroplayers/snake-arena)
> (`pnpm install && pnpm --filter zerosnake build`) and use
> `node <checkout>/packages/cli/bin/zerosnake.js` wherever these docs say `npx zerosnake`.

Then open the folder in Claude Code (`claude`) and describe the snake you want ("make it
aggressive: cut off smaller snakes"). `CLAUDE.md` gives Claude the rules, the API, the limits and
the commands; the skills in `.claude/skills/` cover writing a new strategy, debugging deaths and
comparing versions. You can of course write the code yourself: start with `src/bot.ts` and
`CLAUDE.md`.

When it's ready:

```sh
npx zerosnake login          # sign in through the browser, once
npx zerosnake deploy         # runs the checks, uploads src/, waits for the server's checks
npx zerosnake status         # active version, rating, lives, deploys left today
```

## Commands

| Command                          | What it does                                                         |
| -------------------------------- | -------------------------------------------------------------------- |
| `npx tsc -p .`                   | Type-check the bot.                                                  |
| `npx zerosnake sim`              | A local match vs house bots in the viewer (`--seed`, `--vs`).        |
| `npx zerosnake sim --headless`   | The same match as a summary: scores, kills, deaths, ops per tick.    |
| `npx zerosnake test`             | The server's deploy checks, here. Exit 0 pass, 1 fail.               |
| `npx zerosnake deploy -m "note"` | Check, upload and wait for the server; a failing bot isn't uploaded. |
| `npx zerosnake logs`             | A version's check report and recent lives.                           |
| `npx zerosnake <command> --help` | All the options.                                                     |

About `test`: the seeds of its 5 matches come from your bundle's hash, so every edit plays other
seeds. A bot only just above the `easy` house bot can pass on one version and fail on the next:
aim for a clear margin.

### Inside the monorepo

The `@zerosnake/*` packages are not on npm yet, so `init` leaves the engine, sandbox and house bots
out, and the scripts in `test/` (`npm test`, `npm run bench`, `npm run typecheck`) don't work in an
`init` project; the CLI covers the same ground. They work in a checkout of the
[monorepo](https://github.com/zeroplayers/snake-arena), where this folder is `template/`:

```sh
git clone https://github.com/zeroplayers/snake-arena && cd snake-arena
pnpm install
cd template
pnpm test            # smoke test in the real sandbox: loads, 3 matches, no faults
pnpm bench           # 20 local matches vs house bots: score, deaths, ops per tick
pnpm bench -- --deaths 5                                  # also print the last ticks before 5 deaths
pnpm bench -- src/bot.ts .zerosnake/prev/src/bot.ts       # compare two versions on the same seeds
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
test/               smoke test, bench and the local match runner (monorepo only)
vendor/             the SDK, copied by zerosnake init until it is on npm
CLAUDE.md           rules, API, limits, debugging (for Claude and for you)
AGENTS.md           points other coding agents to CLAUDE.md
.claude/skills/     new-strategy, debug-death, compare-with-previous
```
