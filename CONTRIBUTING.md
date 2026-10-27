# Contributing

Thanks for helping build ZeroSnake Arena. This file covers the repository; how the game works is
in [`docs/`](docs/README.md) and the design in [SPEC.md](SPEC.md).

## Layout

A pnpm monorepo (workspaces in [`pnpm-workspace.yaml`](pnpm-workspace.yaml)):

| Path                | Package                 | What                                                         |
| ------------------- | ----------------------- | ------------------------------------------------------------ |
| `packages/engine`   | `@zerosnake/engine`     | deterministic simulation: world, step, vision, replays       |
| `packages/sdk`      | `@zerosnake/sdk`        | bot types, `defineBot`, `log`, geometry helpers              |
| `packages/sandbox`  | `@zerosnake/sandbox`    | QuickJS bot runner: op budget, memory limits, hardening      |
| `packages/renderer` | `@zerosnake/renderer`   | three.js renderer                                            |
| `packages/viewer`   | `@zerosnake/viewer`     | match and replay viewer on top of the renderer               |
| `packages/rating`   | `@zerosnake/rating`     | version rating: windowed mean, confidence interval, ranking  |
| `packages/cli`      | `zerosnake`             | `npx zerosnake`                                              |
| `bots/house`        | `@zerosnake/house-bots` | built-in bots: easy, medium, hard, chaos                     |
| `apps/web`          | `@zerosnake/web`        | site, auth and deploy API (TanStack Start on Workers, D1)    |
| `apps/arena`        | `@zerosnake/arena`      | arena Worker: matchmaker, rooms, check consumer              |
| `template/`         |                         | starter project for bot authors (`zerosnake init` copies it) |
| `docs/`             | `@zerosnake/docs`       | user documentation and its link check                        |
| `spikes/`           |                         | throwaway experiments with their results                     |

Each package has its `README.md` where there is more to say.

## Development

Requires Node 24+ ([`.nvmrc`](.nvmrc)) and pnpm (`corepack enable`).

```bash
pnpm install
pnpm test          # Vitest across all workspaces
pnpm typecheck     # tsc in every workspace
pnpm lint          # Biome; `pnpm format` fixes formatting
```

Run one package's tests with `pnpm vitest run packages/engine`, or a package script with
`pnpm --filter <package> <script>`. CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs
`pnpm install --frozen-lockfile`, then lint, typecheck and test, on every pull request.

Plain Node can't run the engine's TypeScript directly (it uses parameter properties); scripts use
`node --experimental-transform-types`.

## Conventions

- **English** for everything on GitHub: code, comments, commits, issues and pull requests.
- **TypeScript with `.ts` import extensions** (`import { step } from "./step.ts"`). The shared
  compiler settings are in [`tsconfig.base.json`](tsconfig.base.json): strict,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.
- **Formatting and lint** by Biome ([`biome.json`](biome.json)): 2 spaces, 100 columns, double
  quotes, semicolons. Run `pnpm format` before committing.
- **Never hand-edit `pnpm-lock.yaml`.** Change `package.json` and run `pnpm install`; check the
  result with a clean `pnpm install --frozen-lockfile`.
- **The engine is deterministic.** No `Math.random`, `Date` or `Math.sin`/`Math.cos` in the
  simulation (use the seeded RNG and `math.ts`). Anything that changes results changes replays.
- **Keep the docs true.** If you change a rule, a limit or the bot API, update `docs/` in the same
  pull request. `docs/links.test.ts` fails when a page links to a file that no longer exists.

## Pull requests

- Branch from `main` and open the pull request **into `main`**.
- Title: `Area: what changed (#issue)`, e.g. `Engine: replay format and deterministic playback (#9)`.
- Reference the issue in the description: `Closes #N` when the PR finishes it, `Refs #N` when it is
  part of it.
- `pnpm lint && pnpm typecheck && pnpm test` must pass, and CI must be green.
- Pull requests are squash-merged.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
