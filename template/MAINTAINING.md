# Maintaining the template

This folder is what `npx zerosnake init` gives a bot author. This file is for people working on
the template inside the monorepo. `init` (#14) copies everything except `node_modules`,
`.zerosnake`, caches and this file (`SKIP` in `packages/cli/src/template.ts`).

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

**Today only the CLI is on npm** (`zerosnake`, since 0.1.0). `@zerosnake/sdk`,
`@zerosnake/engine`, `@zerosnake/sandbox` and `@zerosnake/house-bots` are private `0.0.0`
packages, so `init` copies the SDK into `vendor/zerosnake-sdk` (a `file:` dependency) and leaves
the other three out with a note (`PUBLISHED` in `packages/cli/src/init.ts` is empty). `npm install`
works in an `init` project and `npx zerosnake sim` / `test` need nothing more, but `npm test` and
`npm run bench` need the packages: README.md ("Inside the monorepo") and CLAUDE.md (Setup) say so.
The CLI's build ships this folder with `.gitignore` renamed to `gitignore`, which `init` renames
back.

When the other packages are published:

- add each to `PUBLISHED` in `packages/cli/src/init.ts`, and drop the vendored SDK once
  `@zerosnake/sdk` is in it;
- drop the "not on npm yet" notes from README.md and CLAUDE.md;
- consider `"zerosnake": "^<version>"` in `devDependencies`, so a project pins its CLI instead of
  `npx` fetching the latest.

## Why the tests need engine, sandbox and house bots

`test/match.ts` plays real matches: the bot bundled by esbuild, run in `@zerosnake/sandbox` with the
arena's budget, in `@zerosnake/engine` worlds, against `@zerosnake/house-bots`. That gives authors
(and their Claude) a deterministic local loop (`npm test`, `npm run bench`) inside the monorepo.
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
budget used. Use `--from` for seed sets nobody tuned on. The current bot at `turnRate` 0.4 (#98,
October 2026; look-ahead 2 U-turns, margins 0.5, tuned on sets 300000+), with the real checks: no
failures on 600 seed sets (`--from 100000`: lowest 1.14×, 1% 1.42×, 5% 1.74×, median 3.71×) and 3
on 600 more minified (`--from 200000 --minify`: lowest set 200203 at 0.63×, easy 152.7 per life
against 95.7; 1% 1.39×, 5% 1.73×, median 3.86×), so 3 failures and 25 sets below 1.5× in 1200; at
most 0.4× of the per-tick budget on its costliest tick and 0.14× of the suite's average allowance.
The sharper turn made `easy` stronger (about 40 per life instead of 30: it dies less), more than
the bot. (At `turnRate` 0.25 the previous bot had 1 failure and 12 sets below 1.5× in the same
1200, 1% 1.54×, median 4.20×; on the round arena 1 failure in 3600 sets.) `easy`'s own mean score per life ranges from under
10 to over 150 between seed sets (median about 40), and its best sets come from long lucky lives and
kills, which a bot that avoids everyone can't always match. Watch the 1% figure and the failures.
`cli.test.ts` checks three fixed seed sets at ≥ 1.5×; the CLI's other tests use a bot whose seeds
never change (`packages/cli/src/testing/passing-bot.ts`), so a change here doesn't put them at risk.
When the numbers change, update "Keep a margin over `easy`" in `CLAUDE.md`.

The bot must also stay well inside the per-tick budget (the smoke test wants at most half of it
on its seeds). QuickJS counts interrupts per ~10 000 branches or calls, and the sandbox's metering
adds calls of its own, so a few nested loops (feelers × look-ahead ticks × body points) add up
fast: the margin script prints the peak, and running the bot in-process doesn't show it.
