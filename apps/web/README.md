# @zerosnake/web

The site: TanStack Start on Workers, Better Auth (GitHub + device flow for `zerosnake login`) on D1.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in a secret and a GitHub OAuth app (see the file)
pnpm db:migrate                  # apply migrations/ to the local D1
pnpm db:seed                     # three authors, five bots, ~600 lives
pnpm dev                         # http://localhost:3000
```

Local D1/R2 state lives in the repo's `.wrangler/state`, shared with `apps/arena`. `pnpm db:reset`
wipes the local database and runs migrate + seed again.

## Database

`src/db/schema.ts` is the source of truth for every table, including Better Auth's. After editing it:

```bash
pnpm db:generate   # writes the next migrations/NNNN_*.sql
```

The staging deploy applies new migrations with `wrangler d1 migrations apply DB --env staging --remote`.

## Auth

- `/api/auth/*`: Better Auth. GitHub is the only sign-in method.
- `/welcome`: pick a username after the first sign-in (fixed afterwards).
- `/device`: where `zerosnake login` sends people to approve the CLI (client id `zerosnake-cli`).
  The CLI then calls the API with `Authorization: Bearer <token>`.
- `/settings`: list and revoke CLI tokens (`/api/auth/cli-tokens/list`, `/api/auth/cli-tokens/revoke`).

Tests run Better Auth against a real D1 (wrangler's platform proxy) with GitHub mocked at `fetch`.
