# FAQ

## The game

**Can my snake run into its own body?**
No. Only other snakes' bodies and heads, and the wall, kill you. See
[Rules: collisions](rules.md#collisions-and-death).

**What happens when two heads meet?**
The snake with less mass dies and the other gets the kill. With equal mass both die, and each is
credited with killing the other.

**Why did I die at the wall although I was turning away?**
A snake can't stop. At full turn it needs a circle of radius `speed / turnRate`, 6 units at normal
speed and 12 while boosting, and a U-turn takes about 13 ticks. Start turning back while
`state.wallDistance` is still several turning radii. Death happens when the head point crosses the
edge; your body radius doesn't matter there.

**Why doesn't my snake eat the pellet right next to its head?**
Food is only eaten inside a forward cone, within 60° of your heading. A pellet beside you is
skipped until you turn toward it, and a pellet inside your turning circle can be circled forever.
See [Rules: food](rules.md#food).

**What is `length` in the state?**
The snake's mass: food eaten minus hunger and boost. It is not the number of segments. Your score
is the area under it over time, plus 50 per kill.

**I returned `turn: 0.3` but the snake turned by a bit less.**
The engine rounds `turn` to a multiple of 1/128, so 0.3 becomes 0.296875. See
[Rules: turn quantization](rules.md#turn-quantization-1128).

**How long is a life?**
At most 6000 ticks (10 minutes of game time at 10 ticks per second). Then the snake retires and
keeps its score. Rooms without spectators run faster than real time; the showcase room on the home
page runs in real time while someone watches it. No room stays the showcase for more than 10
minutes in a row, and then it rests for 20, so no bot is slowed down for long.

**Does my bot know which snakes are house bots?**
Not reliably, and it shouldn't try. Author names of house bots differ between the SDK docs and the
room code in review, and the check suite deliberately disguises some of them. See
[Bot API: snakes](bot-api.md#snakes-snakeview).

**Will I meet my own other bots in a room?**
No. A room holds at most one snake per author (SPEC §4; rooms are in review in
[#56](https://github.com/zeroplayers/snake-arena/pull/56)).

## Writing a bot

**Does memory survive between ticks? Between lives?**
Between ticks, yes: `mem` and your module's top-level variables persist for the whole life.
Between lives, no: each life starts in a fresh sandbox and `init()` runs again. See
[Bot API: memory](bot-api.md#memory-between-ticks).

**Can I use `Math.random()`?**
Yes. It is seeded per life, so a life is reproducible.

**Can I use npm packages?**
Yes, if they bundle into your single ESM file (≤ 256 KiB) and use nothing the sandbox forbids: no
`async`, `Date`, timers, `fetch`, `eval`, `Proxy` or BigInt. See
[Limits: forbidden features](limits.md#forbidden-features).

**My bot is rejected for `async`, but I never wrote an async function.**
The check is textual and covers the whole bundle, strings included. Look for the word `async` in a
log message or other string, in a `/*! … */` or `@license` comment (esbuild keeps those), or in a
dependency esbuild pulled into the bundle.

**What happens when `tick()` is too slow or throws?**
That tick, your previous action is reused (`{ turn: 0 }` on the first tick). Three over-budget
ticks in a row are a `timeout` death; three throwing ticks in a row are an `error` death. See
[Limits: per-tick budget](limits.md#per-tick-budget).

**My snake died on its first tick with `timeout`.**
Module evaluation plus `init()` went over the load budget (100). Precompute less, or spread the
work over the first ticks and keep the progress in `mem`.

**Where do I see my `log()` output?**
In `zerosnake sim` (the viewer's snake panel), and for arena lives in their traces:
`zerosnake logs --deaths` prints the last ticks before your latest deaths (what the bot saw,
returned, spent and logged), and a death's replay page shows them when you're signed in. Up to 1024
bytes per tick. Traces are kept 7 days and only you can see your bots' logs.

**How long are replays kept?**
Two days. After that a replay is deleted unless it's one of the 100 best lives of all time (by
score) or one of the 5 best lives of a bot in the leaderboard's top 20: those stay while they are
there, and 2 more days after they drop out (so a redeploy doesn't lose your bot's best replays).
A deleted replay's page says it's no longer available. Traces are kept 7 days either way.

**Can I reproduce a match?**
Yes. The engine is deterministic: the same seed, bots and code give the same match.
`zerosnake sim` prints its seed; rerun with `--seed`. Two exceptions: running out of memory in a
room depends on what the other bots in the room use, and `sim --native-house` runs the house bots
outside the sandbox, which is faster but not bit-identical to the arena.

## Deploying and rating

**How many bots can I have?**
3 bots per author, 1 active version per bot, 20 deploys per author per day. See
[Limits: deploy](limits.md#bundle-and-deploy-limits).

**My new version isn't on the leaderboard.**
A version needs to pass the checks (`ready`) and then play 30 lives before it is ranked. See
[Rating](rating.md). For now no version is ranked: the arena doesn't play lives yet (rooms are in
review in [#56](https://github.com/zeroplayers/snake-arena/pull/56), the matchmaker is
[#23](https://github.com/zeroplayers/snake-arena/issues/23)).

**Can I redeploy until I get lucky?**
It doesn't pay: each deploy is a new, unrated version that starts from zero lives, and the
leaderboard ranks by the lower end of the confidence interval. See
[Rating: why redeploying doesn't help](rating.md#why-redeploying-doesnt-help).

**Can other people see my code?**
Yes. Version sources are public on your bot's page; the whole project is open source. You keep
the rights to your code; the site's Terms of Service (`/terms`) say what you let us do with it,
and its Acceptable Use Policy (`/acceptable-use`) what bots may not do. Both are linked at the
bottom of every page.

**What data do you keep, and how do I delete it?**
What GitHub tells us at sign-in, your bots and their games; no tracking cookies. The site's
Privacy Policy (`/privacy`) lists everything and for how long. On the site's Settings page,
**Download my data** gives you a JSON copy and **Delete my account** erases your account, bots
and code.

**Where do I report a bug or a rule that seems wrong?**
In the repository's issues. The rules are whatever the engine does: if these docs and
[`packages/engine`](../packages/engine) disagree, the code is right and the docs need fixing.
