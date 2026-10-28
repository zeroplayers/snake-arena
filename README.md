# ZeroSnake Arena

**Your snake bot vs. everyone else's.** A slither.io-style arena where every snake is a program.
Write a JavaScript or TypeScript bot with Claude, another coding agent or by hand, deploy it with
`npx zerosnake deploy`, and it plays everyone else's bots in rooms that run around the clock. It
earns a rating, and recent deaths come with a replay and a trace of what your bot saw.

Play at **[zerosnake.dev](https://zerosnake.dev)**: watch the arena, read the
[docs](docs/README.md), see the [leaderboard](https://zerosnake.dev/leaderboard).

```bash
npx zerosnake init my-snake   # starter bot, CLAUDE.md, AGENTS.md and skills
cd my-snake
npx zerosnake sim             # your snake vs the house bots, in your browser
npx zerosnake test            # the same checks the server runs
npx zerosnake login           # once, with GitHub
npx zerosnake deploy          # it joins the arena when the checks pass
```

Needs Node.js 24+. Full walkthrough: [Getting started](docs/getting-started.md). Until the
`zerosnake` package is on npm, run the CLI from a checkout:
[Before the packages are published](docs/getting-started.md#before-the-packages-are-published).

## How it works

- **Engine** ([`packages/engine`](packages/engine)): deterministic TypeScript at 10 ticks per
  second with a seeded RNG and its own math, so the same seed and bots give the same match. A
  replay is the seed plus every bot's actions.
- **Sandbox** ([`packages/sandbox`](packages/sandbox)): Workers can't `eval`, so each bot runs in
  its own QuickJS context compiled to WebAssembly, with no I/O and no clock. Bundles are
  instrumented to count work, so the per-tick budget is the same on a laptop and on the server.
  The same package runs in the CLI, the deploy checks and the arena.
- **Arena** ([`apps/arena`](apps/arena)): each room is a Durable Object that simulates in batches;
  a matchmaker fills rooms, and spectators get per-tick deltas over WebSocket.
- **Rating** ([`packages/rating`](packages/rating)): the mean score over a version's last 200
  lives, ranked by the low end of its interval, so a lucky streak can't beat a steady record.
- **Site** ([`apps/web`](apps/web)): TanStack Start on Workers, with D1, R2 and GitHub sign-in.

Rules, the bot API, limits and rating are documented in [`docs/`](docs/README.md); every number
there links to the code it comes from. The product spec is [SPEC.md](SPEC.md), tasks are in
[Issues](../../issues) and [Milestones](../../milestones), and contributing is in
[CONTRIBUTING.md](CONTRIBUTING.md).

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

## Operations

One public environment for now, deployed from `main`. It sits at the permanent addresses (the
published CLI has `https://zerosnake.dev` built in) but its config and resources are still named
`staging` (`env.staging`, `zerosnake-*-staging`). A separate staging can come later
([below](#separate-staging-later)).

| Environment              | Site                                     | Arena API                   |
| ------------------------ | ---------------------------------------- | --------------------------- |
| public (`env.staging`)   | `zerosnake.dev` (`www.` redirects to it) | `api.zerosnake.dev`         |
| separate staging (later) | `staging.zerosnake.dev`                  | `staging-api.zerosnake.dev` |

All of them are in the `zerosnake.dev` zone (Cloudflare account "Surnin Synergy").

### Public environment

Cloudflare account "Surnin Synergy". Config lives in the `env.staging` blocks of
`apps/web/wrangler.jsonc` and `apps/arena/wrangler.jsonc`.

| Worker                    | URL                         | Health                                                   |
| ------------------------- | --------------------------- | -------------------------------------------------------- |
| `zerosnake-web-staging`   | `https://zerosnake.dev`     | [`/api/health`](https://zerosnake.dev/api/health)        |
| `zerosnake-arena-staging` | `https://api.zerosnake.dev` | [`/health`](https://api.zerosnake.dev/health) (pings DO) |

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
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are unset. The token needs the account
permissions listed at the top of the workflow plus the zone `zerosnake.dev` (Workers Routes: Edit,
DNS: Edit) for the custom domains. Each deploy makes a Worker's custom domains exactly those in its
`routes` (wrangler replaces the set), so a hostname removed from `wrangler.jsonc` is detached.

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

**Replay retention**: room replays (R2 `zerosnake-staging-replays`, `apps/web/src/shared/replay.ts`)
are kept 2 days, plus the chunks of pinned lives: the 100 best lives of all time and the 5 best of
each of the top 20 leaderboard bots, each pinned until 2 days after the last run that picked it.
No lifecycle rule can express the exceptions, so don't add one: the site's cron (every 30 minutes,
`apps/web/src/server/replays.ts`) deletes the rest, oldest chunks of each room first, at most
50,000 chunks, 300 list calls and 60 s per run (enough for a few hundred accelerated rooms at
~5,800 chunks a day each), and marks the lives that died in them (`lives.replay_expired_at`,
migration `0012_replay_retention`). If it can't settle the pinned lives, or they shrank to less
than half of the last run's, it deletes nothing. Each run logs `replays.swept` and writes the
`replays.swept` metric: `outcome` `no_pins` or `failed`, or `more` run after run, means replays are
piling up (alerts and recovery in [`apps/web/README.md`](apps/web/README.md#alerts)).

**Admins, rate limits, metrics and alerts**: see "Operations" in
[`apps/web/README.md`](apps/web/README.md#operations). Set `ADMIN_USER_IDS` / `ADMIN_GITHUB_IDS`
in `env.staging.vars` for `/admin`. The rate limit and Analytics Engine bindings need nothing
created beforehand.

**Secrets** (web): `BETTER_AUTH_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, set once with
`pnpm exec wrangler secret put <NAME> --env staging` from `apps/web`. The GitHub App uses
homepage `https://zerosnake.dev` and callback `https://zerosnake.dev/api/auth/callback/github`.

### Separate staging (later)

Not set up yet. It would get its own `wrangler.jsonc` env with its own resources, secrets and
GitHub App, on `staging.zerosnake.dev` (site) and `staging-api.zerosnake.dev` (arena). `SITE_URL`
(`apps/web/src/site.ts`), `DEFAULT_URL` (`packages/cli/src/remote/config.ts`), `robots.txt` and
`sitemap.xml` stay on `zerosnake.dev`: they describe the public site.
