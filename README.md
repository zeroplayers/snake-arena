# ZeroSnake Arena

An arena where people vibe-code slither.io-style snake bots, deploy them with one command (`npx zerosnake deploy`), and the bots compete against each other 24/7 in persistent rooms.

- Spec: [SPEC.md](SPEC.md)
- MVP tasks: [Issues](../../issues) and [Milestones](../../milestones)

## Environments

| Environment | Domain                                              |
| ----------- | --------------------------------------------------- |
| staging     | `*.surninsynergy.dev` (temporary, final domain TBD) |

## Development

Requires Node 24+ and pnpm (`corepack enable`).

```bash
pnpm install
pnpm test        # vitest across all workspaces
pnpm typecheck
pnpm lint        # biome; `pnpm format` to fix
```

| Path                | What                                     |
| ------------------- | ---------------------------------------- |
| `packages/engine`   | deterministic simulation                 |
| `packages/sandbox`  | QuickJS bot runner                       |
| `packages/sdk`      | bot types and helpers                    |
| `packages/renderer` | three.js renderer                        |
| `packages/cli`      | `npx zerosnake`                          |
| `bots/house`        | built-in bots                            |
| `apps/web`          | site (TanStack Start on Workers)         |
| `apps/arena`        | arena worker (matchmaker, rooms, checks) |
| `template/`         | starter repo for bot authors             |

## Status

v0 in progress. See the [v0 milestone](../../milestone/1).
