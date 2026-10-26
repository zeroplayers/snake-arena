# @zerosnake/rating

Version rating and leaderboard (SPEC §4 "Rating", issue #26). Pure TypeScript, no runtime
dependencies; the arena calls it when a life is recorded, the web app when it lists the leaderboard.

```ts
import { addLife, fromRatingsRow, EMPTY_RATING_STATE, leaderboard, rate, toRatingsRow } from "@zerosnake/rating";

let state = row ? fromRatingsRow(row) : EMPTY_RATING_STATE; // D1 `ratings` row of the version
state = addLife(state, life.score); // O(window), the oldest score drops out
await db.update(ratings).set(toRatingsRow(state)); // mean, ci, nLives, recentScores

rate(state); // { mean, ci, n, lives, ranked } or null before the first life
leaderboard(rows); // rows with lives >= 30, best first, each with a `rank`
```

All numbers live in `RatingConfig` (`createRatingConfig({ window, minLives, z })`):

| setting    | default | meaning                                               |
| ---------- | ------: | ----------------------------------------------------- |
| `window`   |     200 | the rating is the mean over the last `window` lives   |
| `minLives` |      30 | a version is ranked from this many lives (all-time)   |
| `z`        |    1.96 | normal quantile of the interval (95%)                 |

## Rating

`mean` is the plain mean of the last 200 life scores. `ci` is the half-width of a
normal-approximation interval, `z × s / √n` with `s` the sample standard deviation of the window;
with one life it is `Infinity` (`null` in the row). Mean and deviation are recomputed from the
window in two passes on every update (compensated sum, corrected sum of squares), so nothing drifts
however many lives a version plays, and a small spread on large scores isn't lost.

Life scores are heavy-tailed (most lives are short, a few run to the life cap), so the interval is
optimistic for small windows: in the simulation below a 30-life interval holds the long-run mean
about 75–80% of the time instead of 95%, a 200-life one about 90%. It is a display aid; ordering
uses the mean. A bootstrap wouldn't fix this at n = 30 (percentile intervals under-cover skewed data
the same way) and costs ~1000× more per update.

## Storage (D1 `ratings`)

A sliding mean has to subtract the score that leaves the window, and no fixed-size summary
remembers which one that is, so the state is the window itself plus the all-time life count
(`RatingState`). Storing it in the row costs ~2–4 KB per version and keeps an update to one row read
and one row write; the alternative, fetching the evicted life from `lives` each time, is an
`OFFSET 200` scan (≈ 200 rows read, billed) per life.

`toRatingsRow` / `fromRatingsRow` map the state to the row. The current schema
(`apps/web/src/db/schema.ts`) needs one new column and one relaxed one:

```sql
-- `ratings` is derived from `lives` and nothing writes it yet, so recreate it rather than
-- rebuilding it column by column (SQLite can't drop NOT NULL in place).
DROP TABLE `ratings`;
CREATE TABLE `ratings` (
	`version_id` text PRIMARY KEY NOT NULL,
	`mean` real NOT NULL,
	`ci` real,                                   -- was NOT NULL: no interval with one life
	`n_lives` integer NOT NULL,                  -- all-time lives (the threshold applies to it)
	`recent_scores` text DEFAULT '[]' NOT NULL,  -- JSON array, last <= 200 scores, oldest first
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `ratings_mean_idx` ON `ratings` (`mean`);
```

Drizzle: `ci: real("ci")`, `recentScores: text("recent_scores").notNull().default("[]")`.

Also worth changing with it:

- `lives.score` is `integer`. Scores are `massArea × 0.001 + 50 × kills`, and a weak bot's lives
  average 10–50, so rounding to integers costs it a few percent of its rating. Make it `real`.
- The leaderboard query orders by `mean` only; add `ci` ascending and `n_lives` descending to match
  `compareRated` (ranked rows always have a non-null `ci`).

Integration notes for the arena:

- Count finished lives only, faults (timeout, errors) included. A life cut short by the platform
  (room shut down, deploy, crash) shouldn't count.
- The update is read-modify-write. A version plays one life at a time, so writes for a version are
  sequential already; guarding the `UPDATE` with `WHERE n_lives = :previous` makes a lost update
  visible if that ever changes.
- A rating can be rebuilt from `lives` at any time: `createRatingState(last200Scores, totalLives)`.

## Leaderboard

`leaderboard(rows, { minLives })` filters to ranked versions and orders by mean (higher first), then
narrower interval, then more lives, then `id` so the output doesn't depend on input order. Full
ties share a rank ("1, 2, 2, 4"). Rows keep their other fields, so it takes the D1 join as is.
`compareRated` is the comparator alone.

## Room-strength normalization

`normalizeScore(score, strength, config)` scales a life by `(strength / reference) ^ alpha`,
clamped to `[1 / maxFactor, maxFactor]`, where `strength` is `roomStrength(others, unrated)`: the
(time-weighted) mean rating of the other snakes in the room. It is off by default
(`DEFAULT_NORMALIZATION.enabled = false`); see the measurements below.
