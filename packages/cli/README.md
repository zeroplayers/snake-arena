# zerosnake (CLI)

```bash
npx zerosnake init my-snake    # new bot project from template/ (offline)
cd my-snake
npx zerosnake sim              # local match in the sandbox, opens the viewer
npx zerosnake test             # the deploy checks (#13)
```

`--help` on any command lists its options. Exit codes: `0` ok, `1` the bot failed (didn't
build, didn't load, failed a check, or was killed by the sandbox in `sim --headless`), `2` bad
command line.

## `sim`

```bash
zerosnake sim [--vs easy,hard,./other-bot.ts] [--seed N] [--ticks N] [--headless] [--native-house]
```

- The bot is bundled with esbuild into one ESM file (`bundleBot`, the same bundle `deploy` will
  upload) and checked like the server checks it (`checkSource` on the bundle; a problem is traced
  back to the source line through the bundle's source map).
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

## `init` and dependencies

`init` copies `template/` (shipped in `dist/template`). Monorepo dependencies (`workspace:*`)
become `^version` for packages on npm (`PUBLISHED` in `src/init.ts`, empty until the launch,
#31). Until then the SDK is copied into the project (`vendor/zerosnake-sdk`, a `file:`
dependency, so `npm install` works and editors see the types), and the other `@zerosnake/*`
packages, which only the template's own tests use, are left out with a note. `sim` and `test`
don't need an install: without one, the CLI bundles the bot against its own copy of the SDK.

## Packaging

`prepack` runs `scripts/build.ts`, which builds a self-contained `dist/`: `cli.js` (the CLI and
every workspace package it uses), `client.js` (the viewer page), `house/*.js` (house bot
bundles), `sdk/` and `template/`. The package ships only `bin/` and `dist/`; its dependencies
are esbuild and QuickJS. `src/pack.test.ts` packs it, installs it outside the monorepo and runs
`init` and `sim --headless`. The package stays `private` until publishing is decided (#31).

In a checkout, build once with `pnpm --filter zerosnake build` before running
`bin/zerosnake.js`; the bin never builds by itself. Tests run the sources directly.
