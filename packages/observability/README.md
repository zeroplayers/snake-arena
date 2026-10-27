# @zerosnake/observability

Structured logs and Analytics Engine metrics shared by the site (`apps/web`) and the arena
(`apps/arena`). No dependencies and no bindings of its own: callers pass their
`analytics_engine_datasets` binding.

```ts
import { log, logger, writeMetric } from "@zerosnake/observability";

log("info", "room.started", { roomId, mode }); // one object per call, indexed by Workers Logs
const requestLog = logger({ requestId, worker: "arena" });
requestLog.error("room.alarm_failed", { roomId, error }); // Errors become { name, message, stack }

writeMetric(env.METRICS, "life.ended", {
  versionId,
  deathCause,
  roomId,
  score,
  ticks,
  kills,
}); // fire and forget, never throws, a missing binding skips it
```

## Logs

`log(level, event, fields)` writes one object (`{ level, event, ...fields }`) with
`console.log/warn/error`. With `observability.enabled` in wrangler config, Workers Logs indexes
every field, so the dashboard's query builder can filter on `event`, `requestId`, `userId`,
`route`, `outcome` and so on. `wrangler tail --format json` and Logpush give the same records as
JSON lines. Field conventions are in [`src/log.ts`](src/log.ts).

## Metrics

One Analytics Engine dataset per environment, shared by both Workers: `zerosnake_dev` locally
and `zerosnake_staging` on staging. Every event has a fixed layout:

| column     | holds                                                   |
| ---------- | ------------------------------------------------------- |
| `index1`   | event name (Analytics Engine samples per index)         |
| `blob1`    | event name                                              |
| `blob2`    | worker: `web` or `arena`                                |
| `blob3…`   | the event's blobs, in order                             |
| `double1`  | `1`, so `SUM(_sample_interval * double1)` counts events |
| `double2…` | the event's doubles, in order                           |

Never reorder or reuse a position; add fields at the end, or add a new event.

| event                 | worker | blobs (`blob3…`)                                      | doubles (`double2…`)                                                                                                                                           |
| --------------------- | ------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy.accepted`     | web    | `userId`                                              | `status`                                                                                                                                                       |
| `deploy.rejected`     | web    | `reason` (error code), `userId`                       | `status`                                                                                                                                                       |
| `http.error`          | web    | `route` (`page` for pages), `outcome`                 | `status`                                                                                                                                                       |
| `ratelimit.limited`   | web    | `rule`, `route`                                       |                                                                                                                                                                |
| `auth.failure`        | web    | `kind`, `route`                                       | `status`                                                                                                                                                       |
| `moderation.action`   | web    | `action`                                              |                                                                                                                                                                |
| `arena.liveness`      | web    | `status` (`ok`/`idle`/`exhausted`/`paused`/`stalled`) | `minutesSinceActivity`, `readyVersions`, `thresholdMinutes`, `playableVersions`                                                                                |
| `replays.swept`       | web    | `outcome` (`done`/`more`/`no_pins`/`failed`)          | `deleted`, `pinnedChunks`, `pinnedLives`, `expiredLives`, `rooms`, `roomsSwept`, `lists`, `durationMs`                                                         |
| `room.started`        | arena  | `roomId`, `mode`                                      | `maxSnakes`                                                                                                                                                    |
| `room.batch`          | arena  | `roomId`, `mode`                                      | `ticks`, `snakes`, `workUnits`, `botTicks`, `batches`, `livesStarted`, `livesEnded`, `wallMs`, `maxWallMs`, `periodMs`, `spectators`, `watched`, `cut`, `tick` |
| `room.crashed`        | arena  | `roomId`, `cause`, `versionId`                        | `restarts`, `gapMs`, `callMs`                                                                                                                                  |
| `room.closed`         | arena  | `roomId`, `reason`                                    | `ticks`, `lives`, `durationMs`                                                                                                                                 |
| `life.ended`          | arena  | `versionId`, `deathCause`, `roomId`                   | `score`, `ticks`, `kills`, `durationMs`                                                                                                                        |
| `room.evicted`        | arena  | `roomId`, `versionId`                                 | `evictions`, `versionKills`                                                                                                                                    |
| `version.quarantined` | arena  | `versionId`, `by`, `roomId`                           | `evictions`, `kills`                                                                                                                                           |
| `checks.finished`     | arena  | `outcome`, `reason`                                   | `durationMs`, `attempt`                                                                                                                                        |
| `arena.gauge`         | arena  | (none)                                                | `rooms`, `liveSnakes`, `queuedLives`, `readyVersions`, `exhausted`, `paused`                                                                                   |
| `room.stalled`        | arena  | `roomId`, `reason`                                    | `tick`, `stalledMs`, `outbox`                                                                                                                                  |

`METRICS` in [`src/metrics.ts`](src/metrics.ts) is the source of truth; `metricColumns(name)`
gives one event's mapping.

### apps/arena

`apps/arena` writes the arena events: the rooms, the matchmaker and the checks consumer (where,
when, and what each field means: `METRICS` here and "Metrics, logs and alerts" in
[`apps/arena/README.md`](../../apps/arena/README.md#metrics-logs-and-alerts), with the dashboard
queries and the arena's alerts). In short: room count and mode (`room.batch` by `roomId` and
`mode`, or `arena.gauge.rooms`), ticks/s (`SUM(ticks) / seconds` over `room.batch`), lives per
hour (`room.batch.livesStarted`, `life.ended` by `deathCause`), rejected versions
(`checks.finished` with `outcome = 'rejected'`). DO CPU isn't measurable from inside workerd,
which doesn't expose CPU time to code. Read it from the Durable Objects metrics in the dashboard
(Workers & Pages → `zerosnake-arena-staging` → Metrics), or from the GraphQL dataset
`durableObjectsInvocationsAdaptiveGroups` (`cpuTime`). `workUnits` is the deterministic proxy
for CPU inside rooms.

## Querying

Analytics Engine SQL API (token with Account Analytics Read):

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --data "SELECT blob3 AS reason, SUM(_sample_interval) AS n FROM zerosnake_staging
          WHERE blob1 = 'deploy.rejected' AND timestamp > NOW() - INTERVAL '1' DAY
          GROUP BY reason ORDER BY n DESC"
```

Useful queries (dataset `zerosnake_staging`; in a Cloudflare Monitor write the table as
`events.analyticsEngine.zerosnake_staging`):

```sql
-- Lives per hour
SELECT toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS hour, SUM(_sample_interval) AS lives
FROM zerosnake_staging WHERE blob1 = 'life.ended' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY hour ORDER BY hour

-- Ticks per second over the last 5 minutes
SELECT SUM(_sample_interval * double2) / 300 AS ticks_per_s
FROM zerosnake_staging WHERE blob1 = 'room.batch' AND timestamp > NOW() - INTERVAL '5' MINUTE

-- Rooms right now
SELECT argMax(double2, timestamp) AS rooms
FROM zerosnake_staging WHERE blob1 = 'arena.gauge' AND timestamp > NOW() - INTERVAL '5' MINUTE

-- 429s by rule and route
SELECT blob3 AS rule, blob4 AS route, SUM(_sample_interval) AS n FROM zerosnake_staging
WHERE blob1 = 'ratelimit.limited' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY rule, route ORDER BY n DESC
```

Alerts on these are set up in the Cloudflare dashboard; see "Operations → Alerts" in
[`apps/web/README.md`](../../apps/web/README.md#alerts).
