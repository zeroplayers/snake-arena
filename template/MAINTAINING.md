# Maintaining the template

This folder is what `npx zerosnake init` gives a bot author. This file is for people working on
the template inside the monorepo. `init` (#14) copies everything except `node_modules`,
`.zerosnake` and caches, so this file goes along too; harmless, but adding it to the CLI's skip list
would be tidier.

## Workspace member, copyable standalone

`template/` is a pnpm workspace member (`pnpm-workspace.yaml` lists it), so:

- its `@zerosnake/*` dependencies are `workspace:*` and always build against the current `main`;
- `pnpm typecheck` at the root type-checks it (`pnpm -r` runs its `typecheck` script);
- `pnpm test` at the root runs its smoke test (`template` is in the root `vitest.config.ts`
  projects);
- `pnpm lint` (Biome) covers it like any other package.

So a change to the SDK, engine or sandbox that breaks the starter bot, its smoke test or its docs'
examples fails CI here.

It is still self-contained: its `tsconfig.json` does not extend `tsconfig.base.json` and nothing in
it imports from outside the folder, so a copy works once the dependencies resolve from npm.
`zerosnake init` (#14) copies the folder, names the package after the new directory and rewrites
every `workspace:*` range to `^<version>` of that package.

**Today that is not enough:** `@zerosnake/sdk`, `@zerosnake/engine`, `@zerosnake/sandbox` and
`@zerosnake/house-bots` are private `0.0.0` packages, so `npm install` fails in any copy (on
`workspace:*` in a plain copy, on `^0.0.0` after `init`). Authors have to work inside a monorepo
checkout; README.md and CLAUDE.md say so. `zerosnake sim` / `test` from a checkout's CLI work in an
`init`ed folder without an install (the CLI resolves the SDK itself), but `npm test` and
`npm run bench` there need the packages.

When the packages are published:

- drop the "not on npm yet" notes from README.md (Quick start) and CLAUDE.md (Setup);
- add `"zerosnake": "workspace:*"` to `devDependencies` so `npx zerosnake` resolves locally;
- if the template ships inside the published CLI, rename `.gitignore` to `gitignore` (npm drops
  `.gitignore` from packages; `init` renames `gitignore` back, and otherwise writes a default one
  without `.zerosnake/`).

## Why the tests need engine, sandbox and house bots

`test/match.ts` plays real matches: the bot bundled by esbuild, run in `@zerosnake/sandbox` with the
arena's budget, in `@zerosnake/engine` worlds, against `@zerosnake/house-bots`. That gives authors
(and their Claude) a deterministic local loop (`npm test`, `npm run bench`) before the CLI exists.
In an `init` project those packages are left out, so `npm test`, `npm run bench` and
`npm run typecheck` fail there; `CLAUDE.md`, README.md and the skills therefore lead with the CLI
(`npx tsc -p .`, `zerosnake sim --headless`, `zerosnake test`) and mark the bench as monorepo-only.
Keep them in sync with the CLI's commands and output (`packages/cli`), and with the check suite's
rules (`packages/checks`: seeds from the bundle hash, the average budget share, the slow-suite
warning's 20 s in `packages/cli/src/artifact.ts`).

`npm run bench` runs TypeScript with `node --experimental-transform-types` because the engine uses a
TS parameter property, which Node's default type stripping rejects. Published packages will be
compiled JS, so this flag can go then.

## Keeping the docs true

`CLAUDE.md` states numbers from the engine's `DEFAULT_CONFIG`, the sandbox limits and the SDK. When
any of those change, update `CLAUDE.md` (and the skills if a workflow changes). The starter bot
reads every constant at runtime, so it keeps working; the docs are what goes stale.

## The starter bot must win by a margin, on any seeds

`zerosnake test` and the server judge a bundle on the 5 seeds its hash gives. A fresh
`zerosnake init` + `zerosnake test` plays the starter bot's own seeds. Bundles are reproducible
(same sources, same bytes in any folder or machine with the same CLI and its pinned esbuild:
`packages/cli/src/bundle.ts`), but any change to `src/bot.ts`, or to the SDK it bundles, re-rolls
those seeds. So the bot has to qualify whatever the seeds, with room to spare. After changing it
(or the SDK, engine, sandbox or house bots), measure:

```sh
pnpm --filter zerosnake margin --sets 1000    # the real checks on 1000 seed sets, a few minutes
```

It prints the distribution of the margin (mean score per life / easy's in the same seat) and the
budget used. Use `--from` for seed sets nobody tuned on. The current bot on the square arena (#76,
October 2026; corners rounded off to 3 turning radii), with the real checks: no failures on 600 seed
sets (`--from 100000`: lowest 1.06×, 1% 1.54×, 5% 2.08×, median 4.20×) and one on 600 more minified
(`--from 200000 --minify`: set 200310 at 0.84×, easy 93.9 per life against 79.4; 1% 1.48×, 5% 2.15×,
median 4.43×), so 1 failure and 12 sets below 1.5× in 1200; at most 0.7× of the per-tick budget on
its costliest tick and 0.2× of the suite's average allowance. (On the round arena it had 1 failure
in 3600 sets, 1% about 1.55×, median about 4.7×.) `easy`'s own mean score per life ranges from under
10 to over 150 between seed sets (median about 30), and its best sets come from long lucky lives and
kills, which a bot that avoids everyone can't always match. Watch the 1% figure and the failures.
`cli.test.ts` checks three fixed seed sets at ≥ 1.5×; the CLI's other tests use a bot whose seeds
never change (`packages/cli/src/testing/passing-bot.ts`), so a change here doesn't put them at risk.
When the numbers change, update "Keep a margin over `easy`" in `CLAUDE.md`.

The bot must also stay well inside the per-tick budget (the smoke test wants at most half of it
on its seeds). QuickJS counts interrupts per ~10 000 branches or calls, and the sandbox's metering
adds calls of its own, so a few nested loops (feelers × look-ahead ticks × body points) add up
fast: the margin script prints the peak, and running the bot in-process doesn't show it.
