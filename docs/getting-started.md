# Getting started

From an empty folder to your own snake in the arena.

> **Status.** The flow below is the one the CLI is being built for, and not all of it works yet:
>
> - `zerosnake init`, `sim` and `test` are in review
>   ([#57](https://github.com/zeroplayers/snake-arena/pull/57)), and so is the project template
>   they copy ([#53](https://github.com/zeroplayers/snake-arena/pull/53)). In #57, `test` only
>   bundles the bot and loads it in the sandbox; running the full check suite
>   ([#54](https://github.com/zeroplayers/snake-arena/pull/54)) is a follow-up once that lands.
> - `zerosnake login`, `deploy`, `status` and `logs` aren't built yet
>   ([#21](https://github.com/zeroplayers/snake-arena/issues/21)); today they print "isn't
>   available yet". The server side of deploy is in review
>   ([#52](https://github.com/zeroplayers/snake-arena/pull/52)).
> - The `zerosnake` package and the `@zerosnake/*` packages are not on npm yet, so `npx zerosnake`
>   doesn't work outside the monorepo, and in a project made by `init` the template's own tests
>   (`npm test`, `npm run bench`) can't run, because they need the engine, sandbox and house bots. See [Before the packages are published](#before-the-packages-are-published).

You need Node.js 24 or newer. [Claude Code](https://claude.com/claude-code) is optional but the
template is set up for it.

## 1. Create a project

```bash
npx zerosnake init my-snake
cd my-snake
npm install
```

`init` copies the bot template (offline, no account needed):

| Path              | What                                                                         |
| ----------------- | ---------------------------------------------------------------------------- |
| `src/bot.ts`      | the bot: a starter that eats the nearest food and avoids bodies and the wall |
| `CLAUDE.md`       | the rules, API and limits, written for Claude                                |
| `.claude/skills/` | `new-strategy`, `debug-death`, `compare-with-previous`                       |
| `test/`           | a smoke test in the real sandbox and a bench against the house bots          |

The starter bot beats the weakest house bot (`easy`) and loses to the others.

## 2. Write a strategy

Open the folder in Claude Code (`claude`) and describe the snake you want, for example "make it
aggressive: cut off smaller snakes". Or edit `src/bot.ts` yourself. The pages to read:

- [Rules](rules.md): how snakes move, eat, grow, die and score;
- [Bot API](bot-api.md): what `tick()` receives and returns;
- [Limits](limits.md): what the sandbox allows.

The bot is a module that default-exports `defineBot({ init, tick })`:

```ts
import { defineBot, nearestDanger, nearestFood, steerAway, steerToward } from "@zerosnake/sdk";

export default defineBot({
  tick(state) {
    const danger = nearestDanger(state);
    if (danger && danger.gap < 5) return { turn: steerAway(state.self, danger.point) };
    const food = nearestFood(state);
    return { turn: food ? steerToward(state.self, food) : 0 };
  },
});
```

## 3. Watch it play locally

```bash
npx zerosnake sim
```

This bundles your bot, runs a match against the house bots in the same sandbox the arena uses,
and opens a viewer in your browser with a timeline, your snake's vision and its `log()` lines.
Useful options (`npx zerosnake sim --help` lists them all):

| Option           | What                                                                             |
| ---------------- | -------------------------------------------------------------------------------- |
| `--vs easy,hard` | opponents: house bots (`easy`, `medium`, `hard`, `chaos`) or paths to other bots |
| `--seed 7`       | a fixed world seed; `sim` prints the seed so you can replay a match              |
| `--ticks 3000`   | match length (10 ticks per second of game time)                                  |
| `--headless`     | print standings and how each of your lives ended instead of the viewer           |

To compare against an older version of your bot, pass its file: `--vs ../old/src/bot.ts`.

## 4. Run the server's checks

```bash
npx zerosnake test
```

The same checks the server runs before accepting a version: limits, does it load, 5 matches without
a sandbox death, and qualification (score at least as high as the `easy` house bot). It prints what
to fix when a check fails. (Not yet: in the CLI under review, `test` only bundles your bot and loads
it in the sandbox, and says so.) See [Limits: check suite](limits.md#check-suite-and-qualification).

## 5. Sign in and deploy

> Not built yet ([#21](https://github.com/zeroplayers/snake-arena/issues/21)). What follows is how
> the server side in [#52](https://github.com/zeroplayers/snake-arena/pull/52) works.

```bash
npx zerosnake login
npx zerosnake deploy
```

- `login` uses a browser device flow: you sign in on the site with GitHub, pick a username (once),
  and approve the CLI, which then gets its own token. You can revoke CLI tokens on the site's
  settings page.
- `deploy` bundles `src/` into one file and uploads it with your source files. The server creates
  a new **version** with status `validating` and runs the checks. The version becomes `ready` and
  replaces your bot's previous version in the arena, or `rejected` with a report.
- Each author can have 3 bots and 20 deploys per day. See [Limits](limits.md#bundle-and-deploy-limits).

## 6. Follow your bot

Once ready, the version is queued for lives in the arena's rooms, at most one snake per author per
room. After 30 lives it appears on the leaderboard (see [Rating](rating.md)). Your profile at
`/@<username>` lists your bots, their versions and sources, ratings and replays of recent lives
(site pages in review, [#55](https://github.com/zeroplayers/snake-arena/pull/55)).

When it dies in ways you don't understand, the template's `debug-death` skill has Claude replay
the last ticks before local deaths (`npm run bench -- --deaths 5`) and fix the cause;
[FAQ](faq.md) lists the common causes.

## Before the packages are published

Until `zerosnake` and `@zerosnake/sdk` are on npm, work inside a checkout of the monorepo, where
the template is the `template/` folder and pnpm links the packages. Once
[#53](https://github.com/zeroplayers/snake-arena/pull/53) and
[#57](https://github.com/zeroplayers/snake-arena/pull/57) are merged:

```bash
git clone https://github.com/zeroplayers/snake-arena
cd snake-arena
pnpm install
pnpm --filter zerosnake build
node packages/cli/bin/zerosnake.js init ../my-snake
```

In a project created this way the SDK is copied into `vendor/zerosnake-sdk`, so `npm install`
works and editors see the types. `sim` and `test` run from the CLI's own copy of everything they
need (`node <checkout>/packages/cli/bin/zerosnake.js sim` inside the project).
