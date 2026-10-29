# @zerosnake/arena

The arena Worker (SPEC §4–5): `MatchmakerDO` (one, global), `RoomDO` (one per room), the checks
Queue consumer, and a cron. Deployed to `api.zerosnake.dev` (`wrangler.jsonc`, `env.staging`).

| File                       | What                                                              |
| -------------------------- | ----------------------------------------------------------------- |
| `src/matchmaker.ts`        | `MatchmakerDO`: the queue of lives, quotas, rooms                 |
| `src/matchmaker/`          | its SQLite store, D1 reads and tunables                           |
| `src/room.ts`, `src/room/` | `RoomDO`: batched simulation, replays, CPU backstop               |
| `src/protocol.ts`          | the room ↔ matchmaker RPC                                         |
| `src/checks.ts`            | the checks Queue consumer (versions become `ready` or `rejected`) |
| `src/db.ts`                | the arena's D1 writes (`lives`, quarantines, named kills)         |
| `src/room/metrics.ts`      | a room's `room.batch` sums (see "Metrics, logs and alerts")       |

## Matchmaker

D1 is the source of truth for which version of a bot plays (`apps/web/src/shared/arena.ts`). The
matchmaker mirrors it into its own SQLite storage and runs an alarm loop every 3 s
(`MatchmakerConfig.pollMs`), each run bounded (a page of 500 rows, 50 `leave`s, 4 new rooms, 4
room checks):

- **Queue.** One row per bot with a playable version: `ready`, not quarantined, bot and owner
  neither archived nor banned. A bot has at most one life at a time; when it ends, the bot's next
  life goes to the back of the queue, so bots take turns. A bot skipped for a room because its
  author is there keeps its place, and so does a bot changing versions (a deploy or rollback,
  even if the poll sees the old version archived before the new one is ready).
- **Changes.** Versions changed after its `change_seq` cursor are applied in commit order:
  activations by the checks consumer, rollbacks, archives, bans, quarantines. Every 10 minutes it
  re-reads all playable versions (paged) and stops bots it didn't see (deleted accounts). The
  site's `activeVersionChanged` / `arenaControlChanged` only run the loop at once. Lives of a
  version that can't play any more are retired in their rooms (`RoomRpc.leave`), asked again
  with backoff (1 s doubling to 1 min) while the room can't act on it yet (the ticket hasn't
  reached it, or its batch is spawning it) until the life is reported; a bot that switched
  versions plays the new one next.
- **Quotas.** `ARENA_LIMITS.livesPerBotPerDay` (100) lives per bot per UTC day, exact: a life
  counts when it is issued, and stops counting only if the room reports it never started
  (`lifeDropped`). Every report is at least once and keyed by `lifeId`, and a life's state only
  moves forward (`issued` → `ended` / `dropped` / `lost`). On its very first start the
  matchmaker seeds today's usage from D1's `lives`.
- **Rooms.** Rooms pull lives (`nextLife`), never an author already in the room (the room's
  `excludeAuthors` plus the ledger's lives in it). When more than `openThreshold` (10) lives wait,
  the matchmaker opens `ceil((waiting − 10) / 20)` rooms (one if lives wait and no room is open)
  and fills each with up to 20 lives of distinct authors. The matchmaker knows nothing of house
  bots: a room fills every slot real lives don't use with them (an even mix of kinds, several
  copies allowed, `house:<kind>#<n>`), counts only real lives toward `maxSnakes` when it takes
  tickets (`join`) and asks for them (`nextLife`, while fewer than 20 are real), and retires its
  smallest house snake (then the youngest) for each ticket that doesn't fit. So below the
  threshold waiting lives go into open rooms' house slots, and rooms open only on the threshold,
  `roomsPerAlarm` (4) at a time up to `maxRooms` (200). House bots run natively in the room
  (`src/room/house-life.ts`: our own deterministic code, ~40× cheaper than in the sandbox),
  unmetered and never named by the backstop; batches size them at `HOUSE_BOT_TICK_MS`, not a
  sandboxed bot's worst case. A dead house snake is replaced at the
  next batch, after the room has asked the matchmaker for real lives.
  A room closes by itself when only house bots remain and `nextLife` has nothing for it, except
  that while reports of its finished lives are still in its outbox (they wait for their replay
  chunk to be in R2) it keeps going for up to a chunk of real time plus a minute: those bots come
  back to it rather than to a new room (a lone bot plays all its lives in one room).
- **Kill switch.** While `arena_control.paused` is set (read every 30 s, and afresh before
  starting rooms: if that read fails, none starts), `nextLife` returns nothing, no room opens,
  and every life in flight is retired; rooms then close. On resume the matchmaker reconciles
  from D1 and opens rooms again.
- **Engine changes.** A room saved by an older engine that this one can't run (the round arena
  before #76: no `arenaHalfSize` in its world's config, a version 1 replay chunk) closes on its
  next cycle instead of failing every alarm: its lives are reported as `lifeDropped` with reason
  `outdated` (unrated, quota given back, no strike or eviction) and its open chunk is discarded.
  The matchmaker opens new rooms. Deploy apps/arena and apps/web together after such a change:
  the spectator stream's format (`BROADCAST_VERSION`) moves with the engine.
- **Quarantine.** Evicted lives are counted per version across rooms, over the last 7 days and
  since the version last started playing (lifting a quarantine starts the count afresh, so late
  or redelivered reports of old evictions don't put it back); at `EVICTIONS_TO_QUARANTINE` of
  them the matchmaker quarantines the version in D1. A room's own quarantine
  (`versionQuarantined`) and one found in D1 stop the version at once too. Before issuing a life
  it re-reads the version in D1, so a change the poll hasn't seen yet doesn't start a life.
- **Lost lives.** Every minute it compares each room's lives (`status()`) with its ledger; a life
  its room stopped holding (or holds in a room whose tick stopped moving) over 30 minutes ago (by
  these checks; or issued that long ago and never seen held) and nobody reported frees its bot (and still counts toward the quota). Not time since
  issue: a life lasts until the snake dies, up to 24 hours of game time (more in wall time), so a
  strong bot keeps its one life, and its slot, for hours.
- **Heartbeat.** About every minute it upserts `arena_heartbeat` in D1 (lives in flight in rooms
  whose tick moves, rooms): lives reach `lives` only when they end, so the site's liveness check
  reads it.
- **Stuck rooms.** A room counts as holding a life only while its tick moves between checks, so a
  room stuck on its lives (outbox full, alarms failing) frees their bots 30 minutes later; and a
  life held over 48 hours (`maxLifeMs`, more than a capped life can take) is retired.

The cron (every 30 minutes) pings the matchmaker, which (re)starts the alarm loop after the first
deploy. `MatchmakerDO.status()` shows the queue and rooms; `configure()` overrides tunables
(`src/matchmaker/config.ts`) in its storage, without a deploy.

## Room ↔ matchmaker protocol

`src/protocol.ts` has the types. The matchmaker drives a room with `RoomRpc`: `start`, then `join`
for its first lives; afterwards the room pulls. The room reports to `MatchmakerRpc`, through its
outbox (retried until delivered, so at least once):

| Call                 | When                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `nextLife`           | the room has a free slot (after each batch; after `null`, every 10 s)                                                          |
| `lifeEnded`          | a life of a version ended (after its `lives` row and replay chunk)                                                             |
| `lifeDropped`        | a ticket never started: refused by `join`, dropped at spawn, `leave`d or stopped before it spawned; or its room was `outdated` |
| `versionQuarantined` | the room's backstop quarantined a version (already in D1)                                                                      |
| `roomClosed`         | only house bots were left and the queue was empty                                                                              |

Every ticket a room got ends in exactly one `lifeEnded` or `lifeDropped`, except a `join` the
matchmaker made itself and saw refused.

## Metrics, logs and alerts

The arena writes Workers Analytics Engine events through `@zerosnake/observability`
(`writeMetric`), to the `METRICS` binding: dataset `zerosnake_dev` locally, `zerosnake_staging`
on staging, the same dataset as `apps/web`. Field order and column layout (`blob1` = event name,
`blob2` = `arena`, then the event's blobs from `blob3` and doubles from `double2`; `double1` = 1)
are fixed in [`packages/observability`](../../packages/observability/README.md). Without the
binding (tests, a Worker deployed without it) nothing is written, and a write that throws is
ignored: metrics never stop a room, the matchmaker or the consumer.

| event                 | written by                                                | columns used below                                                                                                                                                                                                                                                                                                         |
| --------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `room.started`        | `RoomDO.start` (a new room)                               | `blob3` roomId, `blob4` mode, `double2` maxSnakes                                                                                                                                                                                                                                                                          |
| `room.batch`          | `RoomDO`, sums of its batches, at most every 30 s a room  | `blob3` roomId, `blob4` mode; `double2` ticks, `double5` botTicks, `double6` batches, `double7` livesStarted, `double8` livesEnded, `double9` wallMs, `double10` maxWallMs, `double11` periodMs, `double12` spectators, `double13` watched, `double14` cut, `double15` tick, `double16` realLives, `double17` houseRetired |
| `room.crashed`        | `RoomDO`: each backstop incident, and alarms that threw   | `blob3` roomId, `blob4` cause (`restart`, `overrun`, `suspect`, `evicted`, `overran`, `exception`), `blob5` versionId; `double2` incidents in 24 h                                                                                                                                                                         |
| `room.evicted`        | `RoomDO`: the backstop evicted a life                     | `blob3` roomId, `blob4` versionId                                                                                                                                                                                                                                                                                          |
| `version.quarantined` | `RoomDO` (`room`, `kills`), `MatchmakerDO` (`matchmaker`) | `blob3` versionId, `blob4` by                                                                                                                                                                                                                                                                                              |
| `life.ended`          | `RoomDO`, once the life is delivered                      | `blob3` versionId, `blob4` deathCause (`evicted` and `retired` included), `blob5` roomId                                                                                                                                                                                                                                   |
| `room.closed`         | `RoomDO`                                                  | `blob3` roomId, `blob4` reason (`empty`, `kill_switch`, `superseded`, `outdated`)                                                                                                                                                                                                                                          |
| `arena.gauge`         | `MatchmakerDO` alarm, once a minute                       | `double2` rooms, `double3` lives in flight, `double4` lives waiting, `double5` playable bots, `double6` bots out of today's quota, `double7` paused                                                                                                                                                                        |
| `room.stalled`        | `MatchmakerDO` room check (every minute per room)         | `blob3` roomId, `blob4` reason (`no_progress`, `outbox_full`), `double3` stalledMs                                                                                                                                                                                                                                         |
| `checks.finished`     | checks consumer and its cron                              | `blob3` outcome (`ready`, `superseded`, `rejected`, `unchanged`, `missing`, `failed`, `dead_letter`, `malformed`, `reaped`), `blob4` reason; `double2` durationMs, `double3` attempt                                                                                                                                       |

Overhead: nothing per tick. A room adds its batches up in memory and writes one `room.batch` per
`RoomLimits.metricsMs` (30 s; an eviction loses at most that much of a room's counts), so 200
rooms write ~7 points a second whatever their batch rate. Lives, incidents and check jobs write
one point each; the matchmaker one a minute. Analytics Engine takes at most 250 points per
invocation, so a room's cycle delivers at most `RoomLimits.outboxPerCycle` (100) outbox items,
and so at most 100 `life.ended`, and the cron reaps at most `REAP_LIMIT` (100) versions of each
kind; a backlog (after an outage) waits for the next cycle or run instead of being undercounted.

**CPU.** Workers freeze the clock during CPU work, so code can't measure its own CPU. `wallMs`
is the wall time of a batch's simulation, from its first bot call to its saved result (a timer
moves the clock there): the bots, the engine, the commit and, in watch mode, the markers' syncs
and random waits. The I/O around it (deliveries, the kill switch read, labels for spectators,
loading bundles after a restart) is not in it. `workUnits` (`double4`) is the sandbox's
deterministic cost of the sandboxed bot code (house bots run natively and add none, nor
`botTicks`). DO CPU itself is in the dashboard (Workers & Pages →
`zerosnake-arena-staging` → Metrics → Durable Objects) and the GraphQL dataset
`durableObjectsInvocationsAdaptiveGroups` (`cpuTime`). `room.crashed` with cause `overrun` /
`suspect` / `evicted` is a batch killed by (or suspected of) the CPU limit, `overran` a watched
call that ran past the room's budget, `cut` a batch watch mode ended early.

**Logs.** Incidents are also structured logs (`log()`, indexed by Workers Logs): `room.crashed`
(`error`, `warn` for `restart`), `room.evicted`, `version.quarantined`, `room.outbox_full`,
`room.outbox_failed`, `room.stalled`, `room.closed`, `checks.finished` (`error` for `failed`),
`checks.malformed`, `checks.reaped`, `matchmaker.alarm_failed`, `matchmaker.room_start_failed`.
Filter on `event` and `roomId` (Workers & Pages → `zerosnake-arena-staging` → Logs).

### Dashboard

Queries for the Analytics Engine SQL API (see the package README for `curl`), or as panels in
Grafana's Cloudflare Analytics Engine data source. In a Cloudflare Monitor write the table as
`events.analyticsEngine.zerosnake_staging`. Sums weigh each row by `_sample_interval`.

```sql
-- Rooms by mode (rooms that ran a batch in the last 2 minutes)
SELECT blob4 AS mode, count(DISTINCT blob3) AS rooms
FROM zerosnake_staging WHERE blob1 = 'room.batch' AND timestamp > NOW() - INTERVAL '2' MINUTE
GROUP BY mode

-- Ticks per second, the whole arena, per minute
SELECT toStartOfInterval(timestamp, INTERVAL '1' MINUTE) AS t,
       SUM(_sample_interval * double2) / 60 AS ticks_per_s
FROM zerosnake_staging WHERE blob1 = 'room.batch' AND timestamp > NOW() - INTERVAL '6' HOUR
GROUP BY t ORDER BY t

-- Ticks per second per room, slowest first (last 10 minutes)
SELECT blob3 AS room, argMax(blob4, timestamp) AS mode,
       SUM(_sample_interval * double2) * 1000 / SUM(_sample_interval * double11) AS ticks_per_s,
       max(double12) AS spectators
FROM zerosnake_staging WHERE blob1 = 'room.batch' AND timestamp > NOW() - INTERVAL '10' MINUTE
GROUP BY room ORDER BY ticks_per_s LIMIT 20

-- Lives started per hour
SELECT toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS hour,
       SUM(_sample_interval * double7) AS started
FROM zerosnake_staging WHERE blob1 = 'room.batch' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY hour ORDER BY hour

-- Lives ended per hour, by cause (evicted and retired included)
SELECT toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS hour, blob4 AS cause,
       SUM(_sample_interval) AS lives
FROM zerosnake_staging WHERE blob1 = 'life.ended' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY hour, cause ORDER BY hour, lives DESC

-- Batches: wall time, watch mode, cut short (per 5 minutes)
SELECT toStartOfInterval(timestamp, INTERVAL '5' MINUTE) AS t,
       SUM(_sample_interval * double6) AS batches,
       SUM(_sample_interval * double9) / SUM(_sample_interval * double6) AS avg_wall_ms,
       max(double10) AS max_wall_ms,
       SUM(_sample_interval * double13) AS watched, SUM(_sample_interval * double14) AS cut,
       SUM(_sample_interval * double4) / SUM(_sample_interval * double5) AS work_per_bot_tick
FROM zerosnake_staging WHERE blob1 = 'room.batch' AND timestamp > NOW() - INTERVAL '6' HOUR
GROUP BY t ORDER BY t

-- Backstop incidents by cause, per hour
SELECT toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS hour, blob4 AS cause,
       SUM(_sample_interval) AS n
FROM zerosnake_staging WHERE blob1 = 'room.crashed' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY hour, cause ORDER BY hour

-- Evictions and quarantines, per version (last 7 days)
SELECT blob1 AS event, if(blob1 = 'room.evicted', blob4, blob3) AS version,
       SUM(_sample_interval) AS n
FROM zerosnake_staging
WHERE blob1 IN ('room.evicted', 'version.quarantined') AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY event, version ORDER BY n DESC

-- Matchmaker: rooms, lives in flight and waiting, quota exhaustion (per 5 minutes)
SELECT toStartOfInterval(timestamp, INTERVAL '5' MINUTE) AS t,
       max(double2) AS rooms, max(double3) AS live, max(double4) AS waiting,
       max(double5) AS playable_bots, max(double6) AS out_of_quota, max(double7) AS paused
FROM zerosnake_staging WHERE blob1 = 'arena.gauge' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY t ORDER BY t

-- Checks consumer: outcomes and durations per hour
SELECT toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS hour, blob3 AS outcome,
       SUM(_sample_interval) AS jobs,
       quantileExactWeighted(0.5)(double2, _sample_interval) AS p50_ms,
       quantileExactWeighted(0.95)(double2, _sample_interval) AS p95_ms
FROM zerosnake_staging WHERE blob1 = 'checks.finished' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY hour, outcome ORDER BY hour

-- Why versions are rejected (last 7 days)
SELECT blob4 AS reason, SUM(_sample_interval) AS n
FROM zerosnake_staging
WHERE blob1 = 'checks.finished' AND blob3 IN ('rejected', 'reaped', 'dead_letter')
  AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY reason ORDER BY n DESC
```

### Alerts

Set up as Cloudflare **Monitors** (Alerts → Monitors → Create a Monitor → Threshold → custom SQL
returning one column `value`, Automatic time range, every 5 minutes), as in
[`apps/web/README.md`](../web/README.md#alerts). Monitors and the SQL API are in beta, so check
the query preview when saving. `<window>` is the Monitor's time range.

| alert             | query (`FROM events.analyticsEngine.zerosnake_staging WHERE timestamp > NOW() - <window> AND …`)                                                                                                      | fire when |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Room crashed      | `SELECT SUM(_sample_interval) AS value … blob1 = 'room.crashed' AND blob4 != 'restart'`                                                                                                               | `> 0`     |
| Rooms stuck       | `SELECT SUM(_sample_interval) AS value … blob1 = 'room.stalled'`                                                                                                                                      | `> 0`     |
| Arena not ticking | `SELECT if(max(if(blob1 = 'arena.gauge', double2, 0)) > 0 AND SUM(if(blob1 = 'room.batch', _sample_interval * double2, 0)) = 0, 1, 0) AS value … blob1 IN ('arena.gauge', 'room.batch')` (10 minutes) | `> 0`     |
| Consumer failing  | `SELECT SUM(_sample_interval) AS value … blob1 = 'checks.finished' AND blob3 IN ('failed', 'dead_letter')` (15 minutes)                                                                               | `> 3`     |
| Consumer gave up  | `SELECT SUM(_sample_interval) AS value … blob1 = 'checks.finished' AND blob3 IN ('dead_letter', 'reaped')`                                                                                            | `> 0`     |
| Kill storm        | `SELECT SUM(_sample_interval) AS value … blob1 = 'room.crashed' AND blob4 IN ('overrun', 'suspect', 'evicted', 'overran')` (15 minutes)                                                               | `> 5`     |
| Quarantines       | `SELECT SUM(_sample_interval) AS value … blob1 = 'version.quarantined'` (1 hour)                                                                                                                      | `> 2`     |
- **Room crashed** is #30's "an alert fires when a room crashes". `restart` is left out: a deploy
  or an eviction interrupting a batch is one, and counts for nothing. An alarm that threw is
  one `exception`: the recovery from its batch marker logs, but doesn't write, a second point.
- **Rooms stuck** fires when the matchmaker finds a running room whose tick didn't move for a
  minute or more: `outbox_full` means D1, R2 or the matchmaker keep failing for that room (its
  `room.outbox_failed` logs say which), `no_progress` that its alarm stopped. **Arena not
  ticking** catches the case where no room writes anything while the matchmaker counts rooms
  open (e.g. every room stuck before the matchmaker checks them, or the alarms not running).
  The site's **No lives recorded** liveness alert covers the matchmaker itself.
- **Consumer failing**: jobs erroring on our side (R2, D1) and retried; each one's
  `checks.finished` log has the error. A burst of `dead_letter` / `reaped` means versions are
  being rejected with `checks_failed_to_complete`: usually jobs killed by the CPU limit.
- **Kill storm**: the CPU backstop firing in many rooms, i.e. a bot the sandbox's meter can't
  charge. Group the same query by `blob5` (the version a kill named) and `blob3` (room) to find
  it; evictions and quarantines follow by themselves, and the kill switch (`/admin`) stops the
  arena if they don't.

## Tests

`pnpm test` runs everything in workerd through Miniflare (`src/testing/harness.ts`): D1 migrated
from `apps/web`, R2 and Durable Object storage persisted to a temp dir, so `restart()` behaves
like an eviction. `src/matchmaker.test.ts` runs the real matchmaker against `FakeRoom`s
(`src/testing/matchmaker-worker.ts`: rooms without a simulation, stepped by the test, that record
any second snake of an author) for the 200-bot simulation, and against real rooms end to end.
The harnesses' `metrics` option puts a test `METRICS` binding in place
(`src/testing/metrics.ts`) that keeps every point (`record`) or throws on each write (`throw`);
without it there is none, as in most tests. `*.metrics.test.ts` check the points' fields.
