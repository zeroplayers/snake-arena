# zerosnake (CLI)

```bash
npx zerosnake init my-snake    # new bot project from template/ (offline)
cd my-snake
npx zerosnake sim              # local match in the sandbox, opens the viewer
npx zerosnake test             # the deploy checks (#13)
```

`--help` on any command lists its options. Exit codes: `0` ok, `1` the bot failed (didn't
build, didn't load, failed a check), `2` bad command line.

## `sim`

```bash
zerosnake sim [--vs easy,hard,./other-bot.ts] [--seed N] [--ticks N] [--headless]
```

- The bot is bundled with esbuild into one ESM file (`bundleBot`, the same bundle `deploy` will
  upload) and runs in `@zerosnake/sandbox` with the production op budget, memory limit and
  strike rules. Other local bots (`--vs path`) run in the sandbox too. House bots run natively
  (trusted and deterministic, as in the deploy checks), which makes a match ~4× faster.
- The match runs in Node as fast as it can and is recorded with the engine's `ReplayRecorder`
  in 10-second chunks. A local server (`127.0.0.1:5757`, or the next free port) serves the viewer
  page and streams the chunks plus each bot call's ops and `log()` lines; the page plays them
  back with `RecordedMatchSource`, a `MatchSource` over `ReplayPlayer`. Strikes, throws and the
  sandbox's verdict appear in the snake's log panel as `⚠` lines.
- `--headless` prints standings, each of your lives with how it ended in plain language, and
  op-budget use.
- Every bad outcome is meant to be readable: bundle errors with `file:line:column`, a missing
  default export, `async`/BigInt located in your own file, load failures before the match.

On an M1 Max laptop, `init` takes ~0.2 s and the viewer has its first ticks ~0.5 s after
`sim` starts; a headless 3000-tick match (5 minutes of game time) against the four house bots
takes ~1.4 s.

If the project has no `node_modules`, `@zerosnake/sdk` resolves from the CLI, so a fresh project
can `sim` before any install.

## Running from this repo

`bin/zerosnake.js` rebuilds `dist/` (the CLI bundled with the workspace packages, plus a copy of
`template/`) before every command when `scripts/build.ts` is next to it, so the binary in a
checkout always runs the current sources. `pnpm --filter zerosnake build` does the same by hand.
