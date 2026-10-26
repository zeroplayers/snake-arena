# Maintaining the template

This folder is what `npx zerosnake init` gives a bot author. This file is for people working on
the template inside the monorepo; `init` should not copy it.

## Workspace member, copyable standalone

`template/` is a pnpm workspace member (`pnpm-workspace.yaml` lists it), so:

- its `@zerosnake/*` dependencies are `workspace:*` and always build against the current `main`;
- `pnpm typecheck` at the root type-checks it (`pnpm -r` runs its `typecheck` script);
- `pnpm test` at the root runs its smoke test, provided `template` is in the root
  `vitest.config.ts` projects;
- `pnpm lint` (Biome) covers it like any other package.

So a change to the SDK, engine or sandbox that breaks the starter bot, its smoke test or its docs'
examples fails CI here.

It is still self-contained: its `tsconfig.json` does not extend `tsconfig.base.json` and nothing in
it imports from outside the folder, so a plain copy works once the dependencies resolve from npm.
For that, `zerosnake init` must:

1. copy the folder except `MAINTAINING.md` and `node_modules/`;
2. rewrite every `workspace:*` range in `package.json` to the published version (`^x.y.z`) and set
   `name` to the new directory's name;
3. write `.gitignore` itself (npm drops `.gitignore` files from published packages, so if the
   template ships inside the CLI package, store it under another name and rename it on copy).

Until `@zerosnake/sdk`, `@zerosnake/engine`, `@zerosnake/sandbox` and `@zerosnake/house-bots` are on
npm, a copy outside the monorepo cannot `npm install`. When the CLI is published, add
`zerosnake` as a dev dependency so `npx zerosnake` resolves locally.

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
