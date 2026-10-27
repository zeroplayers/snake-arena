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

## Landing page and docs

- `/` (`src/components/landing/`): the pitch, a live arena and the quick start. The arena is
  `ArenaHero`: after the page has loaded and gone idle, and once it is near the viewport, it loads
  the engine, house bots and three.js and plays `createHeroSource()` (`heroSource.ts`) on a bare
  canvas, paused while off screen or in a background tab, paused from the start for
  `prefers-reduced-motion`. That source is the live showcase (#27) when a showcase room is
  running: a `BroadcastSource` (`@zerosnake/viewer`) on `/api/showcase`, which `src/server.ts`
  proxies over the `SHOWCASE` service binding to the arena's `ShowcaseEntrypoint`, which has no
  public URL (`src/server/showcase.ts`: same origin, per-IP rate limit on opening, and the client
  key the room caps sockets by). Paused, the hero closes the socket, so an idle tab doesn't keep
  a room in real time; playing again reconnects. With no showcase within 4 s, or once it is lost
  (3 failed reconnects, or 10 s without it), it's a house-bot match simulated in the page, and
  the caption says which.
  The quick-start commands and the "Before launch" notes are in `quickstart.ts`.
- `/docs`, `/docs/<page>`: the repository's `docs/*.md`, rendered at build time by the Vite plugin
  in `src/docs/plugin.ts` (markdown-it with raw HTML escaped; page links become site links, other
  repository paths point at GitHub). The site ships the HTML only, one chunk per page.
- `src/site.ts` has the repository URL; set `public: true` when it opens and the "GitHub soon"
  placeholders become links.

## Public pages

| Route                | Data                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/leaderboard`       | `leaderboardQuery` (`src/db/queries.ts`): stored `ratings`, ≥ 30 lives                                                                                              |
| `/@{username}`       | `getProfile`: bots, active version, its rating                                                                                                                      |
| `/@{username}/{bot}` | `src/queries/bot.ts`: versions, rating chart, recent lives; `?v=N` picks the version. Sources from `SOURCES` (`src/queries/sources.ts`), shown as escaped text only |
| `/replay/{lifeId}`   | `src/queries/replay.ts` + the life's chunk from `REPLAYS`, played by `ReplaySource`                                                                                 |

Pages only read `ratings`; the rating job below writes it. `ratings.lower_bound` is a generated
column (`mean - ci`), the leaderboard's sort key.

## Ratings

The rating job (`src/server/ratings.ts`, Cron Trigger every minute) turns `lives` into `ratings`
with `@zerosnake/rating`: mean and 95% interval over the last 200 counted lives, ranked by the
lower bound from 30 lives. The arena only inserts `lives` rows; nothing else writes `ratings`
(a rollback deletes the version's row).

- **Cursor.** Triggers number each finished life in commit order (`lives.seq`, counter in
  `rating_progress.assigned_seq`, `migrations/0007_rating_job.sql`); the job reads lives after
  `rating_progress.rated_seq` in batches of 1000 and moves the cursor in the same transaction as
  the rating writes. Lives the arena writes late just come later in the order. At most 20 000
  lives per run (about 45 D1 queries and well under a second of CPU per 10 000), so a backlog
  drains over a few runs.
- **Counted lives**: started at or after the version's `activated_at` (its current stint),
  `death_cause` not `retired`. A rating needs two of them.
- **Idempotent**: `ratings.life_seq` records which lives a rating covers, and every commit is
  guarded by `rating_progress.rev`, so overlapping runs, a cursor moved back or a life written
  twice never count a life twice.
- **Rebuild** a rating from `lives` by setting `ratings.life_seq = NULL` (the job rebuilds 50 per
  run); `UPDATE rating_progress SET rated_seq = 0 WHERE id = 1` replays every life, which also
  covers versions without a row. Each run logs `ratings.updated` with `backlog`
  (`assigned_seq - rated_seq`); failures log `ratings.update_failed`.

Locally: `curl "http://localhost:3000/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"`.

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
  2 s timeout, and errors are only logged. `MatchmakerDO` takes it as a cue to poll `change_seq`
  at once (it polls every few seconds anyway).
- **Ratings** count only lives started at or after `versions.activated_at`, including when a
  rating is rebuilt from `lives`. Writers store that `activated_at` in `ratings.activated_at`; a
  trigger ignores writes for any other stint, so a rating computed before a rollback can't bring
  the deleted row back.
- **Checks consumer** (`src/shared/checks.ts`): when a version passes, it sets
  `versions.activated_at` and refuses if the bot is archived.

## Operations

Rate limits, the kill switch, bans, logs, metrics and alerts (issue #30). Nothing here relies on
being secret: the code, the limits and the admin list are all public.

### Rate limits

Every `/api/*` request and server function call passes `src/server/edge.ts` (wired in
`src/server.ts`, the Worker's entry) before TanStack Start sees it. The rules are in
`src/server/rate-limit.ts`; the numbers are in `wrangler.jsonc` (`ratelimits`), and a test keeps
the two in sync:

| rule     | key                     | limit   | applies to                                                                                                                   |
| -------- | ----------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `ip`     | client IP (IPv6 by /64) | 300/min | every `/api/*` and `/_serverFn/*` request                                                                                    |
| `auth`   | client IP               | 30/min  | `/api/auth/*` except session reads and CLI token polling: sign-in, OAuth callback, device codes and approval, username claim |
| `user`   | user id                 | 120/min | every CLI API call (CLI token) and server function (web session) of a signed-in user                                         |
| `deploy` | user id                 | 6/min   | `POST /api/bots/:bot/versions`, on top of `user` and the daily quota                                                         |

A refused request gets 429 with `Retry-After` and an `ApiErrorBody`:
`{ "error": "rate_limited", "message": "…", "limit": 300, "retryAfter": 60 }`. Server functions
return `{ ok: false, error: "rate_limited" }`. The CLI already retries 429s that aren't
`quota_exceeded`. The exception is the CLI's device-flow polling (`/api/auth/cli/token`): it
follows the device flow's own throttle (5 s interval, `slow_down` adds 5 s), and a poll refused
by the `ip` limit gets that same RFC 8628 answer, 400 `{ "error": "slow_down" }`.

**Why Cloudflare's rate-limit binding.** It runs on every request at no cost: the counter lives in
the Cloudflare location that served it, with no call to a Durable Object or D1. The trade-off is
precision. Counts are per location and eventually consistent, so a client spread over many
locations, or a burst that lands before the counters sync, gets somewhat more than the limit.
That's acceptable for shedding load and slowing down guessing. Everything that must be exact is
counted in D1, in the same statement as the write: deploys per day, bots per author, lives per
day. If a rule ever needs to be exact, a Durable Object per key can implement `RateLimitBinding`
without changing callers.

Better Auth's own limiter is off (`rateLimit.enabled: false`): it counts in memory per isolate, so
on Workers it limited almost nothing. The `auth` and `ip` rules replace it. A missing binding or
a failing check lets requests through and logs a warning, so the limiter can't take the site down.
The bindings' `namespace_id`s (1001–1004 dev, 2001–2004 staging) only need to be unique in the
account; nothing has to be created.

### Admins, the kill switch and bans (`/admin`)

Admins are listed in wrangler vars, comma-separated: `ADMIN_USER_IDS` (`users.id`) and/or
`ADMIN_GITHUB_IDS` (numeric GitHub account ids, `gh api users/<login> --jq .id`). They are not
GitHub logins: a login can be renamed and then registered by someone else, an id never changes.
To find a user id on staging:

```bash
cd apps/web && pnpm exec wrangler d1 execute DB --env staging --remote --command "SELECT id FROM users WHERE username = '<you>'"
```

`/admin` works like `/bots`: web sessions only (a CLI token is never a session), every change
must come from the site's origin, and each call counts against the admin's `user` rate limit.
Non-admins get "admins only". Rules are in `src/server/moderation.ts`, and the contract for the
arena is in `src/shared/arena.ts` ("Kill switch", "Moderation"):

- **Pause the arena**: `arena_control.paused = 1` (one D1 row). The matchmaker starts no lives and
  retires running ones; rooms check the row too. It's told at once through
  `MatchmakerSiteRpc.arenaControlChanged` (best effort) and must poll the row at least every 30 s.
- **Pause deploys**: `arena_control.deploys_paused = 1`. Deploys get 503 `deploys_paused`.
- **Ban a user**: `users.banned_at`. Every `ready` version of theirs becomes `archived`, and versions
  still in checks become `rejected`. They can sign in and look, but deploys get 403
  `user_banned`, bot management refuses changes, the CLI can't be approved, and their profile and
  leaderboard rows are gone. Admins can't be banned.
- **Ban a bot**: `bots.banned_at`. Same as archiving it, but the owner can't restore it, roll back
  or deploy to it (403 `bot_banned`) until an admin lifts the ban.
- **Ban a version**: `status = 'rejected'` with a failed `moderation` check appended to its
  report. This is final.

Each ban changes `versions.status`, so the matchmaker's `change_seq` poll sees it, and a trigger
(`versions_ready_unbanned`) stops any writer from making a banned bot's version `ready`. Every
action is written to `moderation_actions` (shown on `/admin`), logged as `moderation.action` and
counted in Analytics Engine.

### Logs

Workers Logs is on in both environments (`observability` in `wrangler.jsonc`). Each API request
logs one structured record, `event: "api.request"`, with `requestId` (the `cf-ray`, also sent back
as `x-request-id`), `userId`, `method`, `route` (the pattern, e.g. `/api/bots/:bot/versions`),
`status`, `latencyMs` and `outcome` (the error code, or `ok`). In the dashboard (Workers & Pages →
`zerosnake-web-staging` → Logs), filter on `event`, `route`, `outcome` or `userId`. The helper is
`log()` in `packages/observability`. On the Free plan, Workers Logs keeps 200 000 events a day
for 3 days. If traffic outgrows that, set `observability.logs.head_sampling_rate`.

### Metrics

Counters go to Workers Analytics Engine (`METRICS` binding, dataset `zerosnake_staging` on
staging). The site writes deploys accepted and rejected (with the reason), 429s by rule and route,
authentication failures, 5xx, admin actions and the liveness check. Event names, column layout,
the events `apps/arena` should write (rooms, ticks/s, lives/h, rejected versions) and example
queries are in [`packages/observability/README.md`](../../packages/observability/README.md). The
dataset is created by the first write; Analytics Engine has to be available on the account
(Workers & Pages → Analytics Engine).

### Alerts

Cloudflare has no built-in alert for Worker errors. Set them up as **Monitors** (Alerts →
Monitors → Create a Monitor). A Monitor runs a SQL API query on a schedule and notifies by email
or webhook. Choose **Threshold**, then **custom SQL** returning one column `value`, then a
destination. Monitors and the SQL API are in beta (October 2026), so check the query preview when
saving.

| alert                   | query (Automatic time range, every 5 min)                                                                                                                                                                    | fire when |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| Site errors             | `SELECT SUM(_sample_interval) AS value FROM events.analyticsEngine.zerosnake_staging WHERE blob1 = 'http.error'`                                                                                             | `> 0`     |
| No lives recorded       | `SELECT SUM(_sample_interval) AS value FROM events.analyticsEngine.zerosnake_staging WHERE blob1 = 'arena.liveness' AND blob3 = 'stalled'`                                                                   | `> 0`     |
| Room crashed            | `SELECT SUM(_sample_interval) AS value FROM events.analyticsEngine.zerosnake_staging WHERE blob1 = 'room.crashed' AND blob4 != 'restart'`                                                                    | `> 0`     |
| Auth failures spike     | `SELECT SUM(_sample_interval) AS value FROM events.analyticsEngine.zerosnake_staging WHERE blob1 = 'auth.failure'`                                                                                           | `> 50`    |
| Arena worker exceptions | the Workers logs dataset (`logs.workersLogs`) in the visual builder: script `zerosnake-arena-staging`, error-level logs or exception outcomes. Field names are listed by `cf sql datasets --include-columns` | `> 0`     |

**Room crashed** leaves out `restart`: a deploy or an eviction interrupting a batch is one, and
counts for nothing. The arena's other alerts (rooms stuck, consumer failing, kill storms) are in
[`apps/arena/README.md`](../arena/README.md#alerts).

**No lives recorded** comes from the Cron Trigger (`*/5 * * * *`, `src/server/liveness.ts`). It
reads D1: the newest `lives` rows (by `rowid`, a few rows, not a scan), the latest activation of a
`ready` version and the kill switch's last change (and counts 00:00 UTC, when quotas reset, as
a fresh start). It reports `stalled` when the latest of those is older than
`NO_LIVES_ALERT_MINUTES` (15) while the arena isn't paused and has playable versions: `ready`
ones whose bot hasn't used its `livesPerBotPerDay` lives today. With no `ready` versions it's
`idle` (house bots write no `lives` rows); when every bot's daily quota is used up, it's
`exhausted` until 00:00 UTC, not an alert. Each run also logs
`arena.liveness`, at level `error` with `alert: "no_lives"` when stalled, so a Workers Logs alert
works as well. Locally, trigger it with
`curl "http://localhost:3000/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*"`.
