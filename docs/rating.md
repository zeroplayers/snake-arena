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

Every finished life of the version adds its [score](rules.md#score) to the rating. Lives that
end in a `timeout` or `error` count like any other death. Lives cut short by the platform (a room
shutting down, a server deploy) don't.

## The number: mean over the last 200 lives

| Setting    | Default | Meaning                                         |
| ---------- | ------- | ----------------------------------------------- |
| `window`   | 200     | the rating is the mean of the last 200 lives    |
| `minLives` | 30      | a version is ranked once it has 30 lives in all |
| `z`        | 1.96    | the confidence interval is 95%                  |
- **`mean`** is the plain average of the last 200 life scores (fewer while the version is new).
  Older lives drop out, so a version's rating follows how it does now.
- **`ci`** is the half-width of a 95% confidence interval: `1.96 × s / √n`, with `s` the standard
  deviation of the scores in the window and `n` their number. With a single life the interval is
  unbounded.
- The site shows `mean ± ci` ([`format.ts`](../apps/web/src/components/format.ts)).

Life scores are very noisy: most lives are short and a few run to the life cap, so a single life's
standard deviation is about 3.5 times its mean. Even a 200-life rating is off by about 25%, and the
95% interval holds the true mean only about 70–77% of the time at 30 lives and 83–89% at 200
(simulation in the [rating README](../packages/rating/README.md)). Two versions are reliably
ordered only when their true means differ by well over half.

## The leaderboard: ranked by the lower bound

- Only **`ready`** versions (the active version of each bot) with at least **30 lives** are
  ranked (`RANKED_MIN_LIVES`). An archived version keeps its rating on the bot page but leaves the
  leaderboard.
- **At most one version per bot.** A bot has only one active version (the unique index
  `versions_bot_ready_idx` in [`apps/web/src/db/schema.ts`](../apps/web/src/db/schema.ts)), so this
  always holds.
- Order: by the **lower bound `mean − ci`**, highest first; then the narrower interval; then more
  lives; then version id, so the order is the same however the rows come in. In D1 the lower
  bound is the generated column `ratings.lower_bound`, sorted through the index
  `ratings_rank_idx`.

Ranking by the lower bound instead of the mean means a version has to be good **and** have played
enough lives to prove it. A lucky 30-life streak has a wide interval and a low lower bound, so it
can't jump past a version that is consistently better.

## Why redeploying doesn't help

- **A new version starts from zero.** Ratings belong to versions. Redeploying the same code gives a
  new, unrated version that needs 30 lives before it is ranked at all, while the version it
  replaced leaves the leaderboard.
- **One active version per bot.** You can't run several copies of one bot and keep the best one:
  when a new version passes the checks, the previous one is archived.
- **Lucky streaks don't stick.** In the rating simulation, an author who redeploys the same code
  10 times and keeps the luckiest 30-life version outranks a rival that is truly 1.5× better in
  72% of trials when ranking by mean, and in 4% when ranking by the lower bound. And an active
  version keeps playing, so its luck washes out of the 200-life window anyway.
- **Deploys are limited** to 20 per author per day (see [Limits](limits.md)).

What does help is a better bot. To compare versions fairly before deploying, run them on the same
seeds locally: `npm run bench -- src/bot.ts <old bot>` in your project plays both on the same
seeds and lineup, and `zerosnake sim --seed <n> --vs <old bot>` lets you watch them meet.

## Rooms and fairness

The same bot scores very differently depending on who else is in its room: in the rating
simulation, 4–13× more in a room of weak bots than in a room of strong ones. Rooms are filled from
a first-in, first-out queue, and house bots top them up when there aren't enough real bots, so
rooms are weaker when few real bots are online. Over 200 lives this mostly evens out, but not
completely, so treat rank differences between bots whose ranges overlap as noise. Each life's room
strength is recorded, and a room-strength normalization exists
([`normalize.ts`](../packages/rating/src/normalize.ts)) but is **off** at launch; it will be
switched on, and announced, if arena data shows some versions systematically landing in weaker or
stronger rooms.
