# @zerosnake/rating

Version rating and leaderboard (SPEC §4 "Rating", issue #26). Pure TypeScript, no runtime
dependencies; the arena calls it when a life is recorded, the web app when it lists the leaderboard.

```ts
import {
  addLife,
  fromRatingsRow,
  EMPTY_RATING_STATE,
  leaderboard,
  rate,
  toRatingsRow,
} from "@zerosnake/rating";

// D1 `ratings` row of the version; `null` back means the window was scored differently: rebuild
let state = row ? fromRatingsRow(row) : EMPTY_RATING_STATE;
state = addLife(state, life.score); // O(window), the oldest score drops out
await db.update(ratings).set(toRatingsRow(state)); // mean, ci, lowerBound, nLives, recentScores

rate(state); // { mean, ci, n, lives, ranked } or null before the first life
leaderboard(rows); // ready versions with >= 30 lives, one per bot, by mean − ci, each with a `rank`
```

All numbers live in `RatingConfig` (`createRatingConfig({ window, minLives, z })`):

| setting    | default | meaning                                             |
| ---------- | ------: | --------------------------------------------------- |
| `window`   |     200 | the rating is the mean over the last `window` lives |
| `minLives` |      30 | a version is ranked from this many lives (all-time) |
| `z`        |    1.96 | normal quantile of the interval (95%)               |

## Rating

`mean` is the plain mean of the last 200 life scores. `ci` is the half-width of a
normal-approximation interval, `z × s / √n` with `s` the sample standard deviation of the window;
with one life it is `Infinity` (`null` in the row). Mean and deviation are recomputed from the
window in two passes on every update (compensated sum, corrected sum of squares), so nothing drifts
however many lives a version plays, and a small spread on large scores isn't lost.

Life scores are heavy-tailed (most lives are short, a few run to the life cap), so the interval is
optimistic: in the simulation below a nominal 95% interval holds the long-run mean 70–77% of the
time at 30 lives and 83–89% at 200. The leaderboard ranks by its lower end anyway (below). A bootstrap
wouldn't fix this (percentile intervals under-cover skewed samples the same way) and costs ~1000×
more per update.

The scores are also very noisy: a single life's standard deviation is ~3.5× its mean, so a 200-life
rating has a coefficient of variation of ~25%. Two versions are reliably ordered only when their true
means differ by well over half. See "Findings" below.

## Storage (D1 `ratings`)

A sliding mean has to subtract the score that leaves the window, and no fixed-size summary
remembers which one that is, so the state is the window itself plus the all-time life count
(`RatingState`). Storing it in the row costs ~2–4 KB per version and keeps an update to one row read
and one row write; the alternative, fetching the evicted life from `lives` each time, is an
`OFFSET 200` scan (≈ 200 rows read, billed) per life.

`toRatingsRow` / `fromRatingsRow` map the state to the row. The current schema
(`apps/web/src/db/schema.ts`) needs two new columns and one relaxed one:

```sql
-- `ratings` is derived from `lives` and nothing writes it yet, so recreate it rather than
-- rebuilding it column by column (SQLite can't drop NOT NULL in place).
DROP TABLE `ratings`;
CREATE TABLE `ratings` (
	`version_id` text PRIMARY KEY NOT NULL,
	`mean` real NOT NULL,
	`ci` real,                    -- was NOT NULL: no interval with one life
	`lower_bound` real,           -- new: mean - ci, the leaderboard's sort key
	`n_lives` integer NOT NULL,   -- all-time lives (the threshold applies to it)
	`recent_scores` text NOT NULL, -- new: encodeWindow(), see below
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `ratings_rank_idx` ON `ratings` (`lower_bound`);
```

Drizzle: `ci: real("ci")`, `lowerBound: real("lower_bound")`, `recentScores: text("recent_scores").notNull()`.

`recent_scores` is `{"v":1,"scoring":"raw","scores":[…]}`: the last ≤ 200 scores, oldest first,
and how they were computed. `scoring` is `"raw"`, or `scoringKey(normalization)` (e.g.
`"norm:600:0.9:2"`) for normalized lives. `toRatingsRow(state, config, scoring)` writes it and
`fromRatingsRow(row, config, scoring)` returns `null` when the stored window was scored differently,
so turning normalization on (or retuning it) can never mix raw and adjusted scores in one window: the
caller rebuilds from `lives` instead. That rebuild needs each life's room strength, so record it in
`lives` from day one (see "Findings").

Also worth changing with it:

- `lives.score` is `integer`. Scores are `massArea × 0.001 + 50 × kills`, and a weak bot's lives
  average 10–50, so rounding to integers costs it a few percent of its rating. Make it `real`.
- The leaderboard query orders by `mean` only. To match `leaderboard()` it should keep only
  `versions.status = 'ready'` (it does), order by `lower_bound DESC, ci ASC, n_lives DESC,
  version_id`, and list one version per bot (the unique ready version per bot already guarantees
  it). Or fetch the rows and pass them to `leaderboard()`.

Integration notes for the arena:

- Count finished lives only, faults (timeout, errors) included. A life cut short by the platform
  (room shut down, deploy, crash) shouldn't count.
- The update is read-modify-write. A version plays one life at a time, so writes for a version are
  sequential already; guarding the `UPDATE` with `WHERE n_lives = :previous` makes a lost update
  visible if that ever changes.
- A rating can be rebuilt from `lives` at any time: `createRatingState(last200Scores, totalLives)`.
- Scores must be finite and within ±`MAX_LIFE_SCORE` (1e12); anything else throws, so a corrupt
  life can't overflow the sums into a NaN rating.

## Leaderboard

`leaderboard(rows, { minLives })` takes `RatedVersion` rows, named as in D1 (`versionId`, `botId`,
`status` from `versions`; `mean`, `ci`, `nLives` from `ratings`), and returns them best first with
`rank` and `lowerBound` added. Other fields are kept, so a Drizzle select of these columns plus the
bot name and author goes in as is. The rules:

- **Only `ready` versions** with at least `minLives` (30) lives are ranked. An archived version's
  rating stays in D1 for the bot page but can't sit on the leaderboard.
- **At most one version per bot**, its best one. D1 allows one ready version per bot, so this is a
  guard.
- **Ordered by the lower bound `mean − ci`**, then the narrower interval, then more lives, then
  `versionId`, so the output doesn't depend on input order. Rows tying on all three share a rank
  ("1, 2, 2, 4"). The page still shows `mean ± ci`; `lowerBound` is there to explain the order.

Why the lower bound and not the mean: a 30-life mean is off by about ±60% (life sd ≈ 3.5× mean), so
the point mean rewards luck. An author who redeploys the same code K times and keeps the luckiest
30-life version outranks a rival that is truly 1.5× better (200 lives) in 38% / 72% / 92% of trials
for K = 3 / 10 / 30 when ranked by mean, and in 1.5% / 4% / 7.5% when ranked by the lower bound
(lognormal lives, `leaderboard.test.ts`). A version that stays active keeps playing, so its luck
washes out of the 200-life window within days either way.

`compareRated` is the comparator alone; `lowerBound(row)` is the sort key.

## Room-strength normalization

`normalizeScore(score, strength, config)` scales a life by `(strength / reference) ^ alpha`,
clamped to `[1 / maxFactor, maxFactor]`, where `strength` is `roomStrength(others, unrated)`: the
(time-weighted) mean rating of the other snakes in the room. It is off by default
(`DEFAULT_NORMALIZATION.enabled = false`); see the measurements below.

## Simulation: how much does the room matter?

`pnpm --filter @zerosnake/rating sim` (`sim/room-skew.ts`) plays 12-snake rooms of house bots
(`@zerosnake/engine` + `@zerosnake/house-bots`, dev dependencies only) in five fixed compositions,
from weak (chaos or easy filler) to strong. Every room has at least one easy, medium and hard bot, so
each kind is measured everywhere. Bots respawn on death, so a composition holds for the whole match;
every life that starts after a 1000-tick warm-up and before the end is played out and recorded.
A kind's rating is the mean of its per-room means (uniformly random room assignment), and the
strength a life sees is the mean rating of the other 11 snakes. Env vars (`MATCHES`, `TICKS`,
`SAVE`, `LOAD`, …) are documented at the top of the script.

Run of 40 matches × 30 000 ticks per composition (406 368 lives, ~7 min on 9 threads):

| room (E/M/H/C counts) | easy       | medium       | hard         |
| --------------------- | ---------- | ------------ | ------------ |
| chaos (1/1/1/9)       | 25 (s 343) | 854 (s 264)  | 802 (s 267)  |
| easy (10/1/1)         | 52 (s 180) | 2222 (s 101) | 2540 (s 104) |
| balanced (4/4/4)      | 20 (s 646) | 527 (s 567)  | 422 (s 569)  |
| medium (1/10/1)       | 16 (s 889) | 432 (s 811)  | 368 (s 813)  |
| hard (1/1/10)         | 13 (s 867) | 425 (s 788)  | 190 (s 791)  |

Mean life score per kind and room, `s` = strength seen. Long-run ratings: easy 25, medium 892,
hard 864 (chaos 224).

Normalization, with `alpha` fitted on the _other_ two kinds (leave-one-out) and `maxFactor` 2:

| kind   | raw max/min over rooms | normalized max/min | 200-life rating, stuck in worst vs best room: gap / sd (raw → normalized) |
| ------ | ---------------------: | -----------------: | ------------------------------------------------------------------------: |
| easy   |                    3.9 |                1.7 |                                                                 4.2 → 1.3 |
| medium |                    5.2 |                2.6 |                                                                 7.9 → 3.8 |
| hard   |                   13.4 |                5.4 |                                                                 8.8 → 6.8 |

Pooled elasticity `alpha` ≈ 0.89 (per kind 0.76–1.08). With random rooms, normalization has no
consistent effect on how often 200-life windows rank the three kinds in their long-run order: 56% raw
vs 65% normalized in this run, 61.3% vs 60.5% in a review rerun (8 matches × 20 000 ticks). The
misses are almost all
medium vs hard, whose long-run ratings are 3% apart.

### Findings

1. **Composition skews raw scores a lot.** The same bot scores 4–13× more in a room of weak bots
   than in a room of strong ones; a version that systematically lands in weak or strong rooms is
   off by 4–9 standard deviations of its own rating.
2. **Normalization helps but doesn't fix it.** It halves the spread for every kind, but a single
   "room strength" number can't capture who preys on whom: hard (a hunter) gains 13× from a room of
   easy prey, more than any power of the average rating explains, and loses most among other
   hunters.
3. **Recommendation: leave it off at launch.** With random room assignment and many authors, each
   version sees the same mix of rooms over 200 lives, and the skew averages out; normalization then
   only trims noise a little (sd/mean of a 200-life rating 25–31% → 23–27%) while adding circularity (ratings feed the room
   strength that adjusts ratings) and making the score scale harder to explain. What _does_ create
   systematic skew is non-random assignment, mainly house-bot fill that varies with how many real
   bots are online. So: (a) fill rooms with a fixed mix of house bots, (b) record each life's room
   strength (`roomStrength`, time-weighted) in `lives` from day one, and (c) rerun this analysis on
   arena data; turn `normalizeScore` on, with a refitted `alpha`, if room strength varies between
   versions by more than ~20%.
4. **The window is noisy.** Life scores are heavy-tailed (sd ≈ 3.5× mean), so a 200-life mean has
   ~25% relative error and the CI under-covers (above). Options if the leaderboard churns: a
   longer window, or a robust statistic (trimmed mean or mean of `log(1 + score)`) — both config or
   one-function changes here.
5. **House bots don't rank as expected in 12-snake rooms.** Medium (892) and hard (864) tie in the
   long run, and hard is _below_ medium in the balanced, medium and hard rooms; it wins only where
   there is weak prey. The 6-snake lineup in `@zerosnake/house-bots` (easy < medium < hard) doesn't
   carry over to full rooms; hard's hunting gets it killed when rooms are crowded with hunters.
