# @zerosnake/web

The site: TanStack Start on Workers, Better Auth (GitHub + device flow for `zerosnake login`) on D1.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in a secret and a GitHub OAuth app (see the file)
pnpm db:migrate                  # apply migrations/ to the local D1
pnpm db:seed                     # four authors, six bots, ~650 lives, a recorded replay
pnpm dev                         # http://localhost:3000
```

Local D1/R2 state lives in the repo's `.wrangler/state`, shared with `apps/arena`. `pnpm db:reset`
wipes the local database and runs migrate + seed again.

`pnpm db:seed` runs `seed/dev.sql`, then `seed/pages.ts`, which plays a two-minute match of house
bots standing in for the seed versions, records it with the engine's `ReplayRecorder` and writes
the replay chunk, its lives and every seed version's sources to the local D1/R2. Every public page
has something to show: `/leaderboard`, `/@ada`, `/@ada/greedy`, `/replay/seed-replay-greedy-1`,
and the empty cases `/@newbie`, `/@linus/draft`, `/@grace/wip`.

## Public pages

| Route                | Data                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/leaderboard`       | `leaderboardQuery` (`src/db/queries.ts`): stored `ratings`, ≥ 30 lives                                                                                              |
| `/@{username}`       | `getProfile`: bots, active version, its rating                                                                                                                      |
| `/@{username}/{bot}` | `src/queries/bot.ts`: versions, rating chart, recent lives; `?v=N` picks the version. Sources from `SOURCES` (`src/queries/sources.ts`), shown as escaped text only |
| `/replay/{lifeId}`   | `src/queries/replay.ts` + the life's chunk from `REPLAYS`, played by `ReplaySource`                                                                                 |

Ratings are read, never computed here: when `packages/rating` lands, only `leaderboardQuery` and
the `ratings` columns it reads are involved. `ratings.lower_bound` is a generated column for now;
the rating work can make it a stored one with the same name.

Page views never aggregate `lives`: totals come from `versions.lives_count`, which triggers on
`lives` keep current (`migrations/0002_page_counters.sql`), and every `lives` query is an index
range with a `LIMIT` (latest 20 lives, death causes over the latest 200).

`src/replay/ReplaySource.ts` is the `MatchSource` the viewer plays replays from: it runs the chunks
once through `ReplayPlayer` (checking hashes; on a mismatch it plays on and the page warns), keeps
a world copy every 100 ticks and at each chunk start, and rebuilds any tick from the copy before
it. The page loads the chunk, `@zerosnake/viewer` and three.js only in the browser, after
hydration. It assumes the room spawns each life with the engine snake id equal to `lives.id`, and
that `lives.replay_key` is the chunk holding the death.

## Database

`src/db/schema.ts` is the source of truth for every table, including Better Auth's. After editing it:

```bash
pnpm db:generate   # writes the next migrations/NNNN_*.sql
```

The staging deploy applies new migrations with `wrangler d1 migrations apply DB --env staging --remote`.

## Auth

- `/api/auth/*`: Better Auth. GitHub is the only sign-in method.
- `/welcome`: claim a username after the first sign-in (`POST /api/auth/username/claim`, once).
  `/update-user` is disabled: name and avatar come from GitHub.
- `/device`: where `zerosnake login` sends people to approve the CLI (client id `zerosnake-cli`).
  The CLI polls `POST /api/auth/cli/token` (RFC 8628) and gets an opaque `zsk_…` token, then sends
  `Authorization: Bearer <token>`. CLI tokens are not Better Auth sessions and are stored only as
  SHA-256 hashes in `cli_tokens`; routes acting for the CLI call `authenticateCli()`
  (`src/server/cli-auth.ts`). `GET /cli/me` and `POST /cli/logout` serve `whoami`/`logout`.
- `/settings`: list and revoke CLI tokens (`GET /api/auth/cli/tokens`, `POST /api/auth/cli/tokens/revoke`).

Tests run Better Auth against a real D1 (wrangler's platform proxy) with GitHub mocked at `fetch`.

## CLI API (deploy)

`src/server/cli-api.ts`, behind `Authorization: Bearer zsk_…` only (browser sessions get 401).
Shapes and error codes: `src/shared/deploy.ts`.

| Endpoint                         | For                |
| -------------------------------- | ------------------ |
| `GET /api/me`                    | `zerosnake status` |
| `POST /api/bots`                 | create a bot       |
| `POST /api/bots/:bot/versions`   | `zerosnake deploy` |
| `GET /api/bots/:bot/versions/:n` | status and report  |

A deploy is JSON `{ bundle, sources: [{ path, content }], meta? }`, optionally with an
`Idempotency-Key` header. Limits (`DEPLOY_LIMITS`): ≤ 50 source files, ≤ 1 MB of sources, bundle
≤ 256 KB, sane relative paths, `DEPLOYS_PER_DAY` per author per UTC day and `BOTS_PER_AUTHOR`
(wrangler vars). Then:

1. one `INSERT … SELECT` creates the `validating` version, taking the next `n` and checking the
   quota atomically;
2. the bundle and a `SourceArchive` JSON go to R2 under `<sha256>.js` / `<sha256>.json`;
3. a `CheckJob` goes on `CHECKS_QUEUE` and the row gets `enqueued_at`.

If step 2 or 3 fails, the version becomes `rejected` with a report saying why (and doesn't count
against the quota), and the CLI gets 503. A retry with the same `Idempotency-Key` gets the version
once it's queued, 409 `deploy_in_progress` while the first attempt runs, and takes over an attempt
stuck unqueued for over a minute.

R2 objects are content-addressed, so identical uploads (also across authors) share one object;
never delete one because a version goes away. Uploads happen only after their version row exists
(lost quota races upload nothing), so objects become unreferenced only when versions are deleted,
e.g. with their bot. Cleanup, once that exists, is a mark-and-sweep job: list each bucket and
delete keys older than a day that no `versions.bundle_key` / `source_key` references.

`@zerosnake/web/shared` (`src/shared/`) is what other workspaces may import without pulling in the
site: `CheckJob` and `isCheckJob` for apps/arena's consumer, `CheckReport`, `SourceArchive`, and
the CLI API types.

## Bot management (`/bots`)

Signed-in authors manage their bots on `/bots`. The page's server functions are in
`src/server/manage.ts`; the rules are in `src/server/bot-admin.ts`. Only Better Auth web sessions
get in. A CLI token is not a session, so it gets `unauthorized`. Calls that change something must
also come from the site's origin (`Origin`, or `Sec-Fetch-Site: same-origin`).

- **Bots.** You can create, rename, archive and restore bots. An author has at most
  `BOTS_PER_AUTHOR` active bots; archived ones don't count. The limit is checked in the same
  statement as the insert or restore, so racing requests can't overrun it.
- **Slugs never change.** A rename changes only the display name. `/@user/slug` links and the
  CLI's handle keep working, so no redirects are needed. An archived bot keeps its slug, and its
  page stays reachable (marked archived); the profile lists only active bots.
- **Archiving a bot**, in one transaction: its `ready` version becomes `archived`, and versions
  still in checks become `rejected` (the checks consumer skips non-`validating` rows), so it stops
  playing. The CLI API refuses deploys to it (409 `bot_archived`). Restoring brings it back with
  no active version.
- **Active version.** "Make active" rolls back to an `archived` version. A version only becomes
  `archived` after being `ready`, so these all passed the checks. "Archive" takes the active
  version out of play. Both run as one D1 batch: the old `ready` row is archived before the new
  one is readied, so `versions_bot_ready_idx` never sees two. Each batch first writes an
  `activations` row only if every precondition holds (ownership, status, quota), and every later
  statement is guarded by that row existing, so the batch applies fully or not at all.
- **Rollbacks restart the rating and count as a deploy.** The reactivated version's `ratings` row
  is deleted and `versions.activated_at` moves forward. The rollback uses one of
  `DEPLOYS_PER_DAY` (`src/server/quota.ts`; the CLI API counts it too). A kept rating would let an
  author deploy many versions and switch to the luckiest frozen one. A free restart would let them
  roll back until 30 lives came out lucky. Either way the "redeploy lottery" would be back.
  Archiving the active version is free.
- **Quotas shown:** deploys and rollbacks today against `DEPLOYS_PER_DAY`, active bots against
  `BOTS_PER_AUTHOR`, and per bot the lives started today against 100
  (`ARENA_LIMITS.livesPerBotPerDay`, enforced by the matchmaker). Rejected versions are listed
  with their reports as sentences (`checkReportLines`).

### Contract with the matchmaker

Defined in `src/shared/arena.ts` (`@zerosnake/web/shared`):

- **D1 is the source of truth.** A bot plays its `ready` version, and an archived bot has none.
  The matchmaker reconciles from D1 at start-up and periodically. Triggers set
  `versions.change_seq` to one more than the largest so far on every insert and status change,
  so `WHERE change_seq > ? ORDER BY change_seq` is a cheap incremental poll that never skips a
  commit (`updated_at` is the writer's clock before commit, so it can). Before starting a life,
  check that its version is still `ready`. A trigger aborts any write that would make an archived
  bot's version `ready`, and the leaderboard leaves archived bots out.
- **The RPC is a hint.** After each commit the site calls
  `MATCHMAKER.get(idFromName("global")).activeVersionChanged(change)`, a typed
  `ActiveVersionChange` with the bot, new and previous version, and reason. It is best effort:
  2 s timeout, and errors are only logged. `MatchmakerDO` doesn't implement the method yet (#23),
  so for now it only logs.
- **Ratings** count only lives started at or after `versions.activated_at`, including when a
  rating is rebuilt from `lives`. Writers store that `activated_at` in `ratings.activated_at`; a
  trigger ignores writes for any other stint, so a rating computed before a rollback can't bring
  the deleted row back.
- **Checks consumer** (`src/shared/checks.ts`): when a version passes, it sets
  `versions.activated_at` and refuses if the bot is archived.
