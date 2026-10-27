# ZeroSnake Arena

An arena where people vibe-code slither.io-style snake bots, deploy them with one command (`npx zerosnake deploy`), and the bots compete against each other 24/7 in persistent rooms.

- Spec: [SPEC.md](SPEC.md)
- MVP tasks: [Issues](../../issues) and [Milestones](../../milestones)

## Environments

| Environment | Domain                                              |
| ----------- | --------------------------------------------------- |
| staging     | `*.surninsynergy.dev` (temporary, final domain TBD) |

### Staging

Cloudflare account "Surnin Synergy". Config lives in the `env.staging` blocks of
`apps/web/wrangler.jsonc` and `apps/arena/wrangler.jsonc`.

| Worker                    | URL                                   | Health                                                             |
| ------------------------- | ------------------------------------- | ------------------------------------------------------------------ |
| `zerosnake-web-staging`   | `https://arena.surninsynergy.dev`     | [`/api/health`](https://arena.surninsynergy.dev/api/health)        |
| `zerosnake-arena-staging` | `https://api.arena.surninsynergy.dev` | [`/health`](https://api.arena.surninsynergy.dev/health) (pings DO) |

Resources: D1 `zerosnake-staging` (shared by both Workers), KV `zerosnake-staging-auth` (web only),
R2 `zerosnake-staging-{bundles,sources,replays,traces}`, queues `zerosnake-staging-checks` and
`zerosnake-staging-checks-dlq`.

**Auth storage**: web sessions (Better Auth) live in the KV namespace `zerosnake-staging-auth`, bound
as `AUTH_KV` to the web Worker only, never to arena: the arena runs untrusted bot code and shares the
D1, so no session token is kept there (D1 has only hashes of revoked ones). CLI tokens are in D1 as
SHA-256 hashes, GitHub OAuth tokens encrypted. The namespace was made once with
`pnpm exec wrangler kv namespace create zerosnake-staging-auth` (from `apps/web`); its id is in
`env.staging.kv_namespaces` of `apps/web/wrangler.jsonc`.

**Deploys** happen automatically: `.github/workflows/deploy-staging.yml` runs after CI passes on `main`
(or via "Run workflow"). It builds web, deploys arena (web binds to its Durable Objects), applies D1
migrations, deploys the built web, then curls both health endpoints. The old web runs against the new
schema for a short while, so migrations must not break the code they replace (empty a table before
dropping it in a later release). It skips while the repo secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are unset.

Manual deploy (needs `wrangler login` with access to the account):

```bash
pnpm --filter @zerosnake/arena deploy:staging
pnpm --filter @zerosnake/web deploy:staging
```

**Migrations**: generate with `pnpm db:generate` in `apps/web`, commit the SQL, and CI applies it.
To apply by hand:

```bash
cd apps/web && pnpm exec wrangler d1 migrations apply DB --env staging --remote
```

**Trace retention**: life traces (R2 `zerosnake-staging-traces`, `apps/web/src/shared/trace.ts`) are
kept 7 days. Add the lifecycle rule once per bucket:

```bash
cd apps/arena && pnpm exec wrangler r2 bucket lifecycle add zerosnake-staging-traces expire-traces --expire-days 7
```

Without it the arena's cron (every 30 minutes, `apps/arena/src/traces.ts`) deletes them anyway, up to
10,000 per run; the rule just makes that a no-op.

**Admins, rate limits, metrics and alerts**: see "Operations" in
[`apps/web/README.md`](apps/web/README.md#operations). Set `ADMIN_USER_IDS` / `ADMIN_GITHUB_IDS`
in `env.staging.vars` for `/admin`. The rate limit and Analytics Engine bindings need nothing
created beforehand.

**Secrets** (web): `BETTER_AUTH_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, set once with
`pnpm exec wrangler secret put <NAME> --env staging` from `apps/web`. The staging GitHub OAuth app uses
homepage `https://arena.surninsynergy.dev` and callback `https://arena.surninsynergy.dev/api/auth/callback/github`.

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
