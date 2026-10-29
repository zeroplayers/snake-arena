# Rating

Sources: [`packages/rating`](../packages/rating) ([`README.md`](../packages/rating/README.md),
defaults in [`src/config.ts`](../packages/rating/src/config.ts), order in
[`src/leaderboard.ts`](../packages/rating/src/leaderboard.ts)) and the site's leaderboard query,
`leaderboardQuery` in [`apps/web/src/db/queries.ts`](../apps/web/src/db/queries.ts). The numbers
are defaults and may still be tuned.

## What gets rated

A **version** is rated, not a bot or an author. Each deploy that passes the checks is a new version
and starts unrated, with zero lives (ratings are keyed by version id in the D1 schema,
[`apps/web/src/db/schema.ts`](../apps/web/src/db/schema.ts)).

A life lasts until the snake dies (24 hours of game time at most, see
[Rules: life cap](rules.md#life-cap)). Every finished life of the version adds its
[score](rules.md#score) and its length to the rating. Lives that end in a `timeout` or `error`
count like any other death, and so does a life that reached the life cap. Lives cut short by the
platform (the version was rolled back, archived or banned, the arena was paused) don't.

## The number: points per minute alive

| Setting      | Default | Meaning                                                             |
| ------------ | ------- | ------------------------------------------------------------------- |
| `window`     | 200     | the rating is over the last 200 lives                               |
| `minMinutes` | 60      | a version is ranked once its lives add up to an hour alive (in all) |
| `z`          | 1.96    | the confidence interval is 95%                                      |
- **`mean`** is the version's **points per minute alive** over its last 200 lives: their total
  score divided by their total time alive. So each life weighs as much as it lasted: a 24-hour
  life counts for 24 hours, a life that ate one pellet and died after 5 seconds counts for 5
  seconds. One lucky short life (a kill right after spawning is worth 600 points per minute for
  those 5 seconds) barely moves it, and one long life can't be drowned out by many short ones.
  It estimates what the version earns per minute alive in the long run.
- **`ci`** is the half-width of a 95% confidence interval: the standard error of that ratio
  (delta method) times Student's t for the number of lives, so a version with only a few lives
  gets a wide interval. With a single life the interval is unbounded.
- The site shows `mean ± ci` as "pts/min"
  ([`format.ts`](../apps/web/src/components/format.ts)).

As a guide: mass 100 held for a minute earns 60 points, so a bot that stays around mass 100 rates
about 60 pts/min, plus 50 per kill. In the rating simulation (house bots in 12-snake rooms, see
the [rating README](../packages/rating/README.md)) `easy` rates about 130, `medium` 770 and `hard`
3300 pts/min; the interval holds the long-run rate 63–87% of the time at the ranking threshold and
80–91% over 200 lives (scores are heavy-tailed, so it is optimistic).

Why per minute and not per life: lives last until the snake dies, so a strong bot's lives run for
hours. A mean score per life would let one long life dwarf everything else, and a strong bot would
need weeks to play enough lives to be ranked.

## The leaderboard: ranked by the lower bound

- Only **`ready`** versions (the active version of each bot) whose counted lives add up to **an
  hour alive** (and at least two lives) are ranked (`RANKED_MIN_TICKS`). An archived version keeps
  its rating on the bot page but leaves the leaderboard.
- **At most one version per bot.** A bot has only one active version (the unique index
  `versions_bot_ready_idx` in [`apps/web/src/db/schema.ts`](../apps/web/src/db/schema.ts)), so this
  always holds.
- Order: by the **lower bound `mean − ci`**, highest first; then the narrower interval; then more
  time alive; then version id, so the order is the same however the rows come in. In D1 the lower
  bound is the generated column `ratings.lower_bound`, sorted through the index
  `ratings_rank_idx`.

Ranking by the lower bound instead of the mean means a version has to be good **and** have played
enough to prove it. A lucky first hour has a wide interval and a low lower bound, so it can't jump
past a version that is consistently better.

## Why redeploying doesn't help

- **A new version starts from zero.** Ratings belong to versions. Redeploying the same code gives a
  new, unrated version that needs an hour alive before it is ranked at all, while the version it
  replaced leaves the leaderboard.
- **One active version per bot.** You can't run several copies of one bot and keep the best one:
  when a new version passes the checks, the previous one is archived.
- **Lucky streaks don't stick.** In the rating tests, an author who redeploys the same code 10
  times and keeps the luckiest version after its first hour outranks a rival that is truly 1.5×
  better in about half the trials when ranking by the point estimate, and in under 5% when ranking
  by the lower bound. And an active version keeps playing, so its luck washes out of the window.
- **Deploys are limited** to 20 per author per day (see [Limits](limits.md)).

What does help is a better bot. To compare versions fairly before deploying, run them on the same
seeds locally: `npm run bench -- src/bot.ts <old bot>` in your project plays both on the same
seeds and lineup (its `pts/min` column is this rating), and `zerosnake sim --seed <n> --vs <old
bot>` lets you watch them meet.

## Rooms and fairness

The same bot scores very differently depending on who else is in its room: in the rating
simulation, 3–11× more per minute in a room of weak bots than in a room of strong ones. Rooms are
filled from a first-in, first-out queue, and house bots fill every slot real bots don't use, so
rooms are weaker when few real bots are online. Over many lives this mostly evens out, but not
completely, so treat rank differences between bots whose ranges overlap as noise. A room-strength
normalization exists ([`normalize.ts`](../packages/rating/src/normalize.ts)) but is **off**; it
will be switched on, and announced, if arena data shows some versions systematically landing in
weaker or stronger rooms.
