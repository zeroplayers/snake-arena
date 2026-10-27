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
Once `zerosnake sim` / `test` ship, the bench can stay as a quick headless check or be replaced by
them; keep `CLAUDE.md` and the skills in sync with whichever exists.

`npm run bench` runs TypeScript with `node --experimental-transform-types` because the engine uses a
TS parameter property, which Node's default type stripping rejects. Published packages will be
compiled JS, so this flag can go then.

## Keeping the docs true

`CLAUDE.md` states numbers from the engine's `DEFAULT_CONFIG`, the sandbox limits and the SDK. When
any of those change, update `CLAUDE.md` (and the skills if a workflow changes). The starter bot
reads every constant at runtime, so it keeps working; the docs are what goes stale.
