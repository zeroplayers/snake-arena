# Getting started

From an empty folder to your own snake in the arena.

**What you need:** Node.js 24 or newer (`node -v`) and a terminal. Steps 1–4 run on your machine,
offline and with no account; step 5 needs a GitHub account to sign in. It's free.
[Claude Code](https://claude.com/claude-code) is optional: the template is set up for it, its
`AGENTS.md` points other coding agents (Cursor, Codex, …) to the same instructions, and you can
write the bot by hand.

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

The starter bot beats the weakest house bot (`easy`), which is the bar for entering the arena, so
you can deploy it before changing a line. It loses to the others.

The template's own tests (`npm test`, `npm run bench`) need the engine, sandbox and house-bot
packages, which aren't on npm (only `zerosnake` is); use `npx zerosnake sim` and `npx zerosnake test`,
which bring everything they need. To run the template's own tests, or to work on the CLI, see
[Before the packages are published](#before-the-packages-are-published).

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
to fix when a check fails. See
[Limits: check suite](limits.md#check-suite-and-qualification).

## 5. Sign in and deploy

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
- Each author can have 3 bots and 20 deploys per day. See
  [Limits](limits.md#bundle-and-deploy-limits).

## 6. Follow your bot

Once ready, the version is queued for lives in the arena's rooms, at most one snake per author per
room. After 30 lives it appears on the leaderboard (see [Rating](rating.md)). Your profile at
`/@<username>` lists your bots and their ratings, and each bot's page `/@<username>/<slug>` has its
versions, their sources and replays of recent lives. From the terminal, `npx zerosnake status`
shows your bots' active versions, ratings and lives, and `npx zerosnake logs` a version's check
report and recent lives.

When it dies in ways you don't understand, open that life's replay from the bot page: its trace shows what
your bot saw and returned in its last ticks. Locally, the template's `debug-death` skill has Claude
replay the last ticks before local deaths (`npm run bench -- --deaths 5`) and fix the cause;
[FAQ](faq.md) lists the common causes.

## Before the packages are published

You don't need this to build a bot: `npx zerosnake init` above is enough. Only `zerosnake` is on
npm; `@zerosnake/sdk`, the engine, the sandbox and the house bots are not, so to run the template's
own tests and bench, or to work on the CLI, use a checkout of the monorepo, where the template is
the [`template/`](../template) folder and pnpm links the packages:

```bash
git clone https://github.com/zeroplayers/snake-arena
cd snake-arena
npx pnpm@11 install
npx pnpm@11 --filter zerosnake build
node packages/cli/bin/zerosnake.js init ../my-snake
```

In a project created this way the SDK is copied into `vendor/zerosnake-sdk`, so `npm install`
works and editors see the types. `sim` and `test` run from the CLI's own copy of everything they
need (`node <checkout>/packages/cli/bin/zerosnake.js sim` inside the project).
