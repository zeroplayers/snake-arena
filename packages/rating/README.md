# @zerosnake/rating

Version rating and leaderboard (SPEC §4 "Rating", issue #26). Pure TypeScript, no runtime
dependencies; the site's rating job (`apps/web/src/server/ratings.ts`) calls it for every finished
life, the web app when it lists the leaderboard.

A rating is **points per minute alive**: Σ score / Σ minutes alive over the version's last 200
counted lives. Lives last until the snake dies (the life cap is a 24-hour safety net), so a strong
bot's lives run for hours; a mean score per life would let one long life dwarf everything and make
a strong bot wait weeks for 30 lives.

```ts
import {
  addLife,
  fromRatingsRow,
  EMPTY_RATING_STATE,
  leaderboard,
  rate,
  toRatingsRow,
} from "@zerosnake/rating";

// D1 `ratings` row of the version; `null` back means it can't be continued: rebuild
let state = row ? fromRatingsRow(row) : EMPTY_RATING_STATE;
state = addLife(state, { score: life.score, ticks: life.endTick - life.startTick }); // O(window)
await db.update(ratings).set(toRatingsRow(state)); // mean, ci, lowerBound, nLives, aliveTicks, recentScores

rate(state); // { mean, ci, n, minutes, lives, totalMinutes, ranked } or null before the first life
leaderboard(rows); // ready versions alive >= 1 h, one per bot, by mean − ci, each with a `rank`
```

All numbers live in `RatingConfig` (`createRatingConfig({ window, minMinutes, z, ticksPerMinute })`):

| setting          | default | meaning                                                                   |
| ---------------- | ------: | ------------------------------------------------------------------------- |
| `window`         |     200 | the rating is over the last `window` lives                                |
| `minMinutes`     |      60 | a version is ranked once its lives add up to this many minutes (all-time) |
| `z`              |    1.96 | normal quantile of the interval (95%), turned into Student's t            |
| `ticksPerMinute` |     600 | ticks per minute of game time (`TICK_RATE` 10)                            |

## Rating

**Estimator.** `mean = 600 × Σ scoreᵢ / Σ ticksᵢ` over the window: the ratio estimator. By the
renewal–reward theorem it estimates `E[score] / E[length]`, what the version earns per minute
alive in the long run. It is time-weighted by construction: every life counts for as long as it
lasted. A life that eats one pellet and dies after 5 seconds (about 6 points per minute) moves a
5-hour window by 0.3 points per minute; a 5-second life with a kill (600 per minute for those 5
seconds) by under 2. Averaging per-life rates instead would let that one life add 8 (`rating.test.ts`,
"time weighting"). A bot that genuinely gets kills in short lives does earn a high rate; that is the
metric working, and the 100 lives per day quota bounds how much it can play.

**Window: the last 200 lives, not the last X hours.** A count window keeps the stored state
bounded (200 `[score, ticks]` pairs, a few KB in the row, one row read and one write per update);
a time window would have to keep every life inside it to know which one leaves, and a bot dying
every 5 seconds has 17 000 lives in a day. Versions are immutable code, so a long memory for a bot
whose lives run for hours costs little: only the field around it changes. Inside the window the
ratio weighs lives by length, so the window covers 30 minutes of a weak bot and weeks of a strong
one, and both are rated on what they did.

**Threshold: an hour alive in all**, counted over the stint (`RatingState.ticks`), not just the
window, with an interval: at least two lives' worth of evidence (below). A weak bot gets there
in ~200–270 lives, `medium` in ~40–50, a strong bot in a few long lives.

**Interval.** `ci = t(n_eff − 1) × se`, with

- `n_eff = (Σt)² / Σt²`, the effective number of lives (Kish): `n` when all lives last as long,
  about 1 when one life holds nearly all the time;
- `se` the delta-method standard error of the ratio with the reliability-weights correction for
  `n_eff`, `√(Σ(yᵢ − R·tᵢ)² / (Σt)² · n_eff / (n_eff − 1))` (`ratioSummary`, two-pass and
  compensated, so it doesn't drift); with equal lengths it is the classical ratio-estimator
  variance;
- `t` Student's quantile for `z` (`tQuantile`, Cornish–Fisher, A&S 26.7.5: within 0.1% from 3
  degrees of freedom), at `n_eff − 1` degrees of freedom.

No interval (`ci = ∞`, NULL in D1, unranked) while `n_eff < 2` (`MIN_EFFECTIVE_LIVES`). Counting
lives instead would be wrong for uneven lengths: with an hour-long life at 60 points per minute
and a 1-tick death, the two residuals are forced equal, opposite and tiny, and `n = 2` gives
`ci ≈ 0.04`, a lower bound of 59.96 and a rank, on one life's worth of play (a bot could suicide
at spawn on purpose; short spawn deaths happen anyway). `n_eff ≈ 1.0` there, and still under 2
with a 10-second or 5-minute death; two hour-long lives give `n_eff = 2` and `t(1) ≈ 11`, an
interval wide enough to put the lower bound below 0 (`rating.test.ts`, "leaderboard threshold").
With exponential life lengths `n_eff ≈ n / 2`. A weighted variance would need a model of how a
life's rate varies with its length; the delta method needs none.

Scores are heavy-tailed, so the interval is optimistic (simulation below: 66–87% coverage at the
threshold, 80–91% over 200 lives, for a nominal 95%). The leaderboard ranks by its lower end
anyway. A bootstrap wouldn't fix this (percentile intervals under-cover skewed samples the same
way) and costs ~1000× more per update.

## Storage (D1 `ratings`)

A sliding sum has to subtract the life that leaves the window, so the state is the window itself
plus the all-time life count and ticks alive (`RatingState`). `toRatingsRow` / `fromRatingsRow` map
it to the row (`apps/web/src/db/schema.ts`):

- `mean`, `ci` and the generated `lower_bound` (`mean − ci`, sorted through `ratings_rank_idx`);
- `n_lives` and `alive_ticks` (all-time; the threshold and the tie-break use `alive_ticks`);
- `recent_scores`: `{"v":2,"scoring":"raw","lives":[[score,ticks],…]}`, the last ≤ 200 lives,
  oldest first, and how their scores were computed (`"raw"`, or `scoringKey(normalization)`).

`fromRatingsRow` returns `null` when the window can't be continued: scored differently (so raw and
normalized scores never mix) or in format version 1 (scores without lengths, from when the rating
was a mean per life). The caller rebuilds from `lives`.

Switching formats is the job's own doing (`apps/web/src/server/ratings.ts`, "Format"): on its
first run it finds `rating_progress.format = 1`, deletes every rating and replays every life,
whatever the old job wrote or skipped until the deploy; then triggers (migration 0014) ignore the
old code's cursor moves and version-1 windows, and a version-1 row that got in anyway is marked
for a rebuild (`ratings_rebuild_idx`).

Integration notes:

- Count finished lives only, faults (timeout, errors) included, and lives that reached the life
  cap. A life cut short by the platform (version stopped, arena paused) doesn't count: in `lives`
  both end `retired`, told apart by length (`apps/web/src/shared/lives.ts`).
- A rating can be rebuilt from `lives` at any time:
  `createRatingState(last200, totalLives, totalTicks)`.
- Scores must be finite and within ±`MAX_LIFE_SCORE` (1e12), lengths whole ticks up to
  `MAX_LIFE_TICKS` (a length of 0 counts as 1); anything else throws.

## Leaderboard

`leaderboard(rows, { minMinutes, ticksPerMinute })` takes `RatedVersion` rows, named as in D1
(`versionId`, `botId`, `status` from `versions`; `mean`, `ci`, `nLives`, `aliveTicks` from
`ratings`), and returns them best first with `rank` and `lowerBound` added. Other fields are kept.
The rules:

- **Only `ready` versions** alive at least `minMinutes` in all are ranked.
- **At most one version per bot**, its best one.
- **Ordered by the lower bound `mean − ci`**, then the narrower interval, then more time alive,
  then `versionId`. Rows tying on all three share a rank ("1, 2, 2, 4").

Why the lower bound and not the mean: an author who redeploys the same code 10 times and keeps the
copy with the luckiest first hour outranks a rival that is truly 1.5× better (ten hours of play)
in ~49% of trials when ranked by the point estimate, ~1% by the lower bound (K = 3 / 30: 20% /
82% vs 0.1% / 2%; exponential life lengths, lognormal per-life rates, `leaderboard.test.ts`).

`compareRated` is the comparator alone; `lowerBound(row)` is the sort key.

## Room-strength normalization

`normalizeScore(score, strength, config)` scales a life's score by `(strength / reference) ^ alpha`,
clamped to `[1 / maxFactor, maxFactor]`, where `strength` is `roomStrength(others, unrated)`: the
(time-weighted) mean rating of the other snakes in the room. It is off by default
(`DEFAULT_NORMALIZATION.enabled = false`). `reference` and `alpha` were fitted on per-life scores;
refit both (the simulation below prints per-minute fits) before turning it on.

## Simulation

`pnpm --filter @zerosnake/rating sim` (`sim/room-skew.ts`) plays 12-snake rooms of house bots
(`@zerosnake/engine` + `@zerosnake/house-bots`, dev dependencies only) in five fixed compositions,
from weak (chaos or easy filler) to strong. Every room has at least one easy, medium and hard bot,
so each kind is measured everywhere. Bots respawn on death, so a composition holds for the whole
match; every life that starts after a 1000-tick warm-up and before the end is played out (on the
24-hour cap: house bots' lives last seconds to minutes, the longest ~5000 ticks) and recorded with
its length. A kind's long-run rating with uniformly random rooms is E[score] / E[minutes] averaged
over rooms. Env vars (`MATCHES`, `TICKS`, `SAVE`, `LOAD`, …) are at the top of the script.

Run of 40 matches × 30 000 ticks per composition (263 992 lives, ~5 min on 9 threads):

| room (E/M/H/C counts) | easy pts/min (median life) | medium      | hard        |
| --------------------- | -------------------------- | ----------- | ----------- |
| chaos (1/1/1/9)       | 123 (17 s)                 | 678 (80 s)  | 1435 (52 s) |
| easy (10/1/1)         | 264 (5 s)                  | 1378 (44 s) | 6627 (66 s) |
| balanced (4/4/4)      | 123 (9 s)                  | 661 (41 s)  | 1201 (24 s) |
| medium (1/10/1)       | 107 (11 s)                 | 619 (53 s)  | 1155 (33 s) |
| hard (1/1/10)         | 76 (11 s)                  | 495 (52 s)  | 625 (17 s)  |

Long-run ratings: easy 127, medium 768, hard 3344 pts/min (chaos 216).

| what                                                            |      easy |    medium |      hard |
| --------------------------------------------------------------- | --------: | --------: | --------: |
| room skew, raw max/min rate                                     |       3.5 |       2.8 |      10.6 |
| normalized max/min (leave-one-out alpha)                        |       2.0 |       2.2 |       4.6 |
| 200-life rating in random rooms, sd / mean                      |       24% |       15% |       26% |
| stuck in worst vs best room: gap / sd (raw)                     |       6.2 |       7.8 |       7.0 |
| CI coverage, first hour, random rooms (median lives to an hour) | 86% (226) |  82% (40) |  66% (54) |
| CI coverage, 200 lives, random rooms                            |       84% |       91% |       81% |
| CI coverage, first hour / 200 lives, balanced room              | 87% / 84% | 84% / 90% | 85% / 87% |

Pooled elasticity of the rate to room strength `alpha` ≈ 0.53. 200-life windows rank the three
kinds in their long-run order in 100% of draws, raw or normalized.

### Findings

1. **Per minute separates bots far better than per life.** Under the old metric `medium` and
   `hard` were 3% apart in the long run (892 vs 864 mean score per life) and windows ordered them
   right ~60% of the time; per minute `hard` is 4× `medium` and every window orders them right.
   `hard` dies young but scores fast (kills); per life that looked no better than `medium`.
2. **Composition still skews ratings** (3–11× between the weakest and strongest rooms), slightly
   less than per life (4–13×). Normalization halves it but doesn't fix it; leave it off and rerun
   on arena data, as before.
3. **The interval under-covers at the threshold for hunters** (`hard`: 66%), because a few lives
   in prey-rich rooms are worth 5× the rest. The lower-bound ranking and the t quantile absorb most
   of it; if the leaderboard churns, raise `minMinutes`.
4. **Watch kill trading.** Per minute, a kill (50 points) is worth mass 83 held for a minute, so a
   bot that trades short lives for kills can rate well. Time-weighting is not the issue (each life
   counts for its length); the incentive is. If arena data shows it, the knobs are a minimum
   charged length per life or a smaller `killBonus`.
