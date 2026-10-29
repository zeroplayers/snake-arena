# zerosnake

[![npm](https://img.shields.io/npm/v/zerosnake)](https://www.npmjs.com/package/zerosnake)
[![CI](https://github.com/zeroplayers/snake-arena/actions/workflows/ci.yml/badge.svg)](https://github.com/zeroplayers/snake-arena/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](https://github.com/zeroplayers/snake-arena/blob/main/LICENSE)

The command line for [ZeroSnake Arena](https://zerosnake.dev): a slither.io-style arena where
every snake is a program. Write a JavaScript or TypeScript bot (with Claude, another coding agent
or by hand), play it against the house bots on your machine, then deploy it to rooms that run
around the clock. It earns a rating, and its deaths come with a replay and a trace of what it saw.

## Quick start

Needs Node.js 24 or newer.

```bash
npx zerosnake init my-snake   # starter bot, CLAUDE.md, AGENTS.md and skills (works offline)
cd my-snake
npx zerosnake sim             # your snake vs the house bots, in your browser
npx zerosnake test            # the same checks the server runs, same seeds, same verdict
npx zerosnake login           # once, with GitHub
npx zerosnake deploy          # it joins the arena when the checks pass
```

Then open `claude` (or your agent) in `my-snake` and ask it to make the snake smarter: the project
ships a `CLAUDE.md`, an `AGENTS.md` and skills for debugging deaths and comparing versions.
Your first `deploy` creates your bot; deploying another one later takes `deploy --create`.

- Docs: [rules](https://zerosnake.dev/docs/rules), [bot API](https://zerosnake.dev/docs/bot-api),
  [limits](https://zerosnake.dev/docs/limits) and
  [getting started](https://zerosnake.dev/docs/getting-started)
- Source, issues and contributing:
  [github.com/zeroplayers/snake-arena](https://github.com/zeroplayers/snake-arena)
- Security reports: see
  [SECURITY.md](https://github.com/zeroplayers/snake-arena/blob/main/SECURITY.md)
- License: MIT

The rest of this file is how the CLI works, for contributors.

## Commands

```bash
npx zerosnake init my-snake    # new bot project from template/ (offline)
cd my-snake
npx zerosnake sim              # local match in the sandbox, opens the viewer
npx zerosnake test             # the server's deploy checks, same seeds, same verdict
npx zerosnake login            # device flow in the browser
npx zerosnake deploy           # upload; live once the server's checks pass
npx zerosnake status           # bots, active versions, ratings, deploys left today
npx zerosnake logs             # a version's check report and recent lives
```

`--help` on any command lists its options. Exit codes: `0` ok, `1` the bot failed (didn't
build, didn't load, failed a check, or was killed by the sandbox in `sim --headless`), `2` bad
command line.

## `sim`

```bash
zerosnake sim [--vs easy,hard,./other-bot.ts] [--seed N] [--ticks N] [--headless] [--native-house]
```

- The bot is bundled with esbuild into one ESM file (`bundleBot`, the same bundle `deploy` will
  upload). The same sources give the same bytes in any folder, and comments or formatting don't
  change them. esbuild is pinned to an exact version: the check seeds come from the bundle's hash,
  and another esbuild version may print the same code differently. The bundle is checked like the
  server checks it (`checkSource` on the bundle; a problem is traced back to the source line
  through the bundle's source map).
- Every bot, house bots included, runs in `@zerosnake/sandbox` as in a room: the production op
  budget, memory limit and strike rules. `--native-house` runs house bots in Node instead, ~4×
  faster but not bit-identical to the arena (QuickJS and V8 may round `Math.sin`/`atan2`
  differently).
- The match runs in Node as fast as it can and is recorded with the engine's `ReplayRecorder`
  in 10-second chunks. A local server (`127.0.0.1:5757` or the next free port; it answers only
  `localhost` host names) serves the viewer page and streams the chunks plus each bot call's ops
  and `log()` lines. The page plays them back with `RecordedMatchSource`, a `MatchSource` over
  `ReplayPlayer`. Strikes, throws and the sandbox's verdict show up as `⚠` lines in the snake's
  log panel.
- `--headless` prints standings, each of your lives with how it ended in plain language, and
  op-budget use.

On an M1 Max laptop: `init` ~0.2 s, viewer's first ticks ~0.5 s after `sim` starts, a headless
3000-tick match (5 minutes of game time) against the four house bots ~4 s (~1 s with
`--native-house`).

## `test`

```bash
zerosnake test [--bot src/bot.ts] [--json]
```

- Bundles with `bundleBot` exactly like `sim` and `deploy`, checks the deploy API's limits and
  path rules (`assertWithinLimits` in `src/artifact.ts`), then runs `runChecks` from
  `@zerosnake/checks` with the deploy configuration (`runCheckSuite`): the same suite, seeds
  (from the bundle's hash) and report as the server's checks, so a bot that passes here passes
  there, except on time: here the suite's 60 s wall-clock cap stops a slow bot, while on the
  server the Worker's CPU time limit does, possibly on slower hardware. So a pass that took
  `SLOW_SUITE_MS` (20 s) or more prints a warning (`slowSuiteWarning`) in `test` and `deploy`; it
  doesn't block. See `packages/checks/README.md` for the checks.
- Prints `formatReport` (what to fix included), or the `CheckReport` JSON with `--json` (stdout
  carries only the JSON; the other lines go to stderr). Exit `0` passed, `1` failed.
- The suite runs synchronously and has no progress callback. On a terminal the CLI shows a
  progress line by counting reads of the suite's clock (`clock` option, once per bot tick and
  per life; it returns the real time, so the report is unchanged); elsewhere it prints one line.
- Typical run: 2–5 s for an honest bot. A problem before the matches (a build error, a deploy
  limit) is a plain error with exit 1 and no JSON.

## Remote commands

`login`, `logout`, `deploy`, `status` and `logs` talk to the site's API (`apps/web`, types from
`@zerosnake/web/shared`, bundled into `dist/cli.js`). The server is `--url`, else `ZEROSNAKE_URL`,
else `https://zerosnake.dev`; plain `http` is allowed only for localhost.

- **`login`**: RFC 8628 device flow. `POST /api/auth/device/code` (client `zerosnake-cli`), print
  the code, open `verification_uri_complete`, poll `POST /api/auth/cli/token` at the given interval
  (`slow_down` adds 5 s; network errors and 5xx keep polling until the code expires). The `zsk_…`
  token goes to `credentials.json` in the config folder (`~/Library/Application Support/zerosnake`,
  `%APPDATA%\zerosnake`, `$XDG_CONFIG_HOME/zerosnake` or `~/.config/zerosnake`;
  `ZEROSNAKE_CONFIG_DIR` overrides), one per server, file `0600` in a `0700` folder, written to a
  temporary file and renamed. Tokens are never printed. A new login revokes the token it replaces;
  a token it couldn't finish with (`GET /api/auth/cli/me` failing after retries) is revoked too.
  `ZEROSNAKE_TOKEN` (CI) is used instead of the stored token when set.
- **`logout`**: `POST /api/auth/cli/logout`, then deletes the token here even if the server can't be
  reached (and says to revoke it at `/settings`).
- **`deploy`**: `GET /api/me` first (bot exists? quota left? the server's limits), then bundles
  with `bundleBot` exactly like `sim`, collects the sources (everything under `src/` except hidden
  files, plus other project files the bundle imports, minus a vendored SDK; text only), and runs
  the local checks (`runLocalChecks` in `src/artifact.ts`: the deploy API's limits and path rules,
  then the full check suite, exactly as `test`). A bot that fails them isn't uploaded (exit 1 with
  the report), so it costs no deploy. `--skip-local-checks` skips the suite (not the limits) and
  lets the server decide; on a pass it prints the score against `easy` and any warnings. The upload always carries an `Idempotency-Key` (a UUID per run,
  reused by every retry): network errors, 5xx, a gateway's 429 and `409 deploy_in_progress` are
  retried with backoff for up to 90 s, which outlasts the API's one-minute takeover of a deploy
  that died half way. Then it polls `GET /api/bots/:bot/versions/:n` every 2 s (up to 10 minutes)
  until `ready` or `rejected`, and prints the check report (`formatReport` in `src/artifact.ts`:
  the checks consumer's `{ ok, checks, suite, text, qualificationScore }` prints its `suite` as
  `test` prints it, else its `text`; a bare `@zerosnake/checks` report prints the same way, and
  `{ ok, checks }` alone, like the consumer's "checks didn't finish" report, as one line per check). Still `validating` after that, it exits
  1 and says the checks may not run on this server yet (#22; the API has no hint for that). The
  local upload-size check measures the exact body sent, `meta` included.
  The bot is `--bot <slug>`, else `"zerosnake": { "bot": "<slug>" }` in package.json, else the
  package name as a slug. An author's first deploy creates it (`POST /api/bots`); after that a
  new bot takes `--create`, so a typo can't start one. `--entry <file>` picks the
  entry file (`sim` and `test` call that `--bot`).
- **`status`**: `GET /api/me` (bots, active and latest version, quota) plus the public profile
  `GET /api/users/:username` for each active version's rating (mean ± CI over N lives, ranked from
  30) and lives played.
- **`logs`**: the version (`--version`, else active, else latest), its status, message and check
  report; then `GET /api/bots/:bot/versions/:n/lives?limit=20[&deaths=1]` (an older server without
  it gets a link to the bot's page). With `--deaths`, the death context of the latest 3 deaths
  from `GET /api/lives/:id/trace` (owner only; format in apps/web `src/shared/trace.ts`): totals
  over the life, then the last `--context` ticks (default 10): what the bot saw, returned, spent
  and logged. `--life <id or replay URL>` shows one life's.

Every API failure becomes a plain-language message (`explain` in `src/remote/api.ts`): the
server's `message` plus what to do, for each `ApiErrorBody` code and for non-JSON answers. Redirects
are never followed (the token stays with the server it's for) and never retried: they're reported
as a wrong address or a misconfigured server.

Tests: `src/remote.test.ts` runs the commands against `FakeArena` (an in-memory API with fault
injection); `src/remote.integration.test.ts` runs login → deploy → status → logs → logout against
apps/web's real auth and CLI API (D1/R2/queue through wrangler's platform proxy), with the device
approval and the checks consumer (#22) done on the database.

## `init` and dependencies

`init` copies `template/` (shipped in `dist/template`). Monorepo dependencies (`workspace:*`)
become `^version` for packages on npm (`PUBLISHED` in `src/init.ts`). Only `zerosnake` itself is
on npm, so that set is empty: the SDK is copied into the project (`vendor/zerosnake-sdk`, a
`file:` dependency, so `npm install` works and editors see the types), and the other
`@zerosnake/*` packages, which only the template's own tests use, are left out with a note. `sim`
and `test` don't need an install: without one, the CLI bundles the bot against its own copy of the
SDK.

## Packaging

`prepack` runs `scripts/build.ts`, which builds a self-contained `dist/`: `cli.js` (the CLI and
every workspace package it uses), `client.js` (the viewer page), `house/*.js` (house bot
bundles), `sdk/` and `template/`. The package ships only `bin/` and `dist/` (plus this README,
`LICENSE` and `package.json`); its dependencies are esbuild and QuickJS, both at exact versions:
the check seeds come from the bundle's bytes and the op budget from QuickJS, so a newer patch
release could change a verdict. Keep them in step with `packages/sandbox`. `src/pack.test.ts`
packs it, installs it outside the monorepo and runs `init`, `sim --headless` and `test` (on
`src/testing/passing-bot.ts`, which passes, and on a bot that can't beat `easy`).
`@zerosnake/checks` is bundled into `cli.js` like the other workspace packages.

Releases are packed with `pnpm pack` (it runs `prepack` and rewrites the `workspace:*`
devDependencies; `npm pack` wouldn't) and that tarball is published with `npm publish <tgz>`:
by hand for the first release (0.1.0), then by pushing a `cli-v<version>` tag
([release-cli.yml](https://github.com/zeroplayers/snake-arena/blob/main/.github/workflows/release-cli.yml),
npm trusted publishing). The owner's steps are in
[docs/launch/checklist.md](https://github.com/zeroplayers/snake-arena/blob/main/docs/launch/checklist.md).

In a checkout, build once with `pnpm --filter zerosnake build` before running
`bin/zerosnake.js`; the bin never builds by itself. Tests run the sources directly.
