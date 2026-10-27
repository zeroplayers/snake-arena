# @zerosnake/arena

The arena Worker (SPEC §4–5): `MatchmakerDO` (one, global), `RoomDO` (one per room), the checks
Queue consumer, and a cron. Deployed to `api.arena.surninsynergy.dev` (`wrangler.jsonc`,
`env.staging`).

| File                       | What                                                              |
| -------------------------- | ----------------------------------------------------------------- |
| `src/matchmaker.ts`        | `MatchmakerDO`: the queue of lives, quotas, rooms                 |
| `src/matchmaker/`          | its SQLite store, D1 reads and tunables                           |
| `src/room.ts`, `src/room/` | `RoomDO`: batched simulation, replays, CPU backstop               |
| `src/protocol.ts`          | the room ↔ matchmaker RPC                                         |
| `src/checks.ts`            | the checks Queue consumer (versions become `ready` or `rejected`) |
| `src/db.ts`                | the arena's D1 writes (`lives`, quarantines, named kills)         |

## Matchmaker

D1 is the source of truth for which version of a bot plays (`apps/web/src/shared/arena.ts`). The
matchmaker mirrors it into its own SQLite storage and runs an alarm loop every 3 s
(`MatchmakerConfig.pollMs`), each run bounded (a page of 500 rows, 50 `leave`s, 4 new rooms, 4
room checks):

- **Queue.** One row per bot with a playable version: `ready`, not quarantined, bot and owner
  neither archived nor banned. A bot has at most one life at a time; when it ends, the bot's next
  life goes to the back of the queue, so bots take turns. A bot skipped for a room because its
  author is there keeps its place.
- **Changes.** Versions changed after its `change_seq` cursor are applied in commit order:
  activations by the checks consumer, rollbacks, archives, bans, quarantines. Every 10 minutes it
  re-reads all playable versions (paged) and stops bots it didn't see (deleted accounts). The
  site's `activeVersionChanged` / `arenaControlChanged` only run the loop at once. Lives of a
  version that can't play any more are retired in their rooms (`RoomRpc.leave`); a bot that
  switched versions plays the new one next.
- **Quotas.** `ARENA_LIMITS.livesPerBotPerDay` (100) lives per bot per UTC day, exact: a life
  counts when it is issued, and stops counting only if the room reports it never started
  (`lifeDropped`). Every report is at least once and keyed by `lifeId`, and a life's state only
  moves forward (`issued` → `ended` / `dropped` / `lost`). On its very first start the
  matchmaker seeds today's usage from D1's `lives`.
- **Rooms.** Rooms pull lives (`nextLife`), never an author already in the room (the room's
  `excludeAuthors` plus the ledger's lives in it). When more than `openThreshold` (10) lives wait,
  the matchmaker opens `ceil((waiting − 10) / 20)` rooms (one if lives wait and no room is open)
  and fills each with up to 20 lives of distinct authors; house bots top rooms up to 5 authors.
  A room closes by itself when only house bots remain and `nextLife` has nothing for it. With
  fewer bots than a room holds, a room may close right after all its snakes died, before their
  reports (sent once their replay chunk is in R2) put the bots back in the queue; the next
  alarm opens a new room for them.
- **Kill switch.** While `arena_control.paused` is set (read every 30 s, and before opening a
  room), `nextLife` returns nothing, no room opens, and every life in flight is retired; rooms
  then close. On resume the matchmaker reconciles from D1 and opens rooms again.
- **Quarantine.** Evicted lives are counted per version across rooms; at
  `EVICTIONS_TO_QUARANTINE` the matchmaker quarantines the version in D1. A room's own quarantine
  (`versionQuarantined`) and one found in D1 stop the version at once too. Before issuing a life
  it re-reads the version in D1, so a change the poll hasn't seen yet doesn't start a life.
- **Lost lives.** Every minute it compares each room's lives (`status()`) with its ledger; a life
  issued over 30 minutes ago that its room doesn't hold and nobody reported frees its bot (and
  still counts toward the quota).

The cron (every 30 minutes) pings the matchmaker, which (re)starts the alarm loop after the first
deploy. `MatchmakerDO.status()` shows the queue and rooms; `configure()` overrides tunables
(`src/matchmaker/config.ts`) in its storage, without a deploy.

## Room ↔ matchmaker protocol

`src/protocol.ts` has the types. The matchmaker drives a room with `RoomRpc`: `start`, then `join`
for its first lives; afterwards the room pulls. The room reports to `MatchmakerRpc`, through its
outbox (retried until delivered, so at least once):

| Call                 | When                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `nextLife`           | the room has a free slot (after each batch; after `null`, every 10 s)                              |
| `lifeEnded`          | a life of a version ended (after its `lives` row and replay chunk)                                 |
| `lifeDropped`        | a ticket never started: refused by `join`, dropped at spawn, `leave`d or stopped before it spawned |
| `versionQuarantined` | the room's backstop quarantined a version (already in D1)                                          |
| `roomClosed`         | only house bots were left and the queue was empty                                                  |

Every ticket a room got ends in exactly one `lifeEnded` or `lifeDropped`, except a `join` the
matchmaker made itself and saw refused.

## Tests

`pnpm test` runs everything in workerd through Miniflare (`src/testing/harness.ts`): D1 migrated
from `apps/web`, R2 and Durable Object storage persisted to a temp dir, so `restart()` behaves
like an eviction. `src/matchmaker.test.ts` runs the real matchmaker against `FakeRoom`s
(`src/testing/matchmaker-worker.ts`: rooms without a simulation, stepped by the test, that record
any second snake of an author) for the 200-bot simulation, and against real rooms end to end.
