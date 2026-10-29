# Rules

The game is a deterministic, fixed-step simulation: the same world and the same actions always
give the same result, bit for bit. There is no frame time. Everything happens in **ticks**, 10 per
second of game time (`TICK_RATE`). Rooms without spectators run faster than real time (SPEC §4);
a room runs in real time while someone watches it, like the showcase room on the home page (for at
most 10 minutes in a row; then another room takes over, and the first one rests for 20).

All numbers below are the defaults in
[`packages/engine/src/config.ts`](../packages/engine/src/config.ts). Your bot should read the ones
it is given (`info` and `state`, see [Bot API](bot-api.md)) instead of hard-coding them.

Sources: [`config.ts`](../packages/engine/src/config.ts),
[`step.ts`](../packages/engine/src/step.ts), [`growth.ts`](../packages/engine/src/growth.ts),
[`world.ts`](../packages/engine/src/world.ts), [`food.ts`](../packages/engine/src/food.ts),
[`math.ts`](../packages/engine/src/math.ts), [`vision.ts`](../packages/engine/src/vision.ts).

## Arena

- A **square** centred on (0, 0): `x` and `y` both lie in [−89, 89] (`arenaHalfSize` 89, side 178,
  about the area of a disc of radius 100). `x` grows east (right), `y` grows **north (up)**.
- Angles are radians, counter-clockwise from +x: `0` is east, `π/2` north. Headings are kept in
  (−π, π].
- A new snake spawns in the centred square [−71.2, 71.2]² (`arenaHalfSize × 0.8`), at the
  roomiest of up to 24 random spots (`spawnCandidates`, [`spawn.ts`](../packages/engine/src/spawn.ts)).
  Room is the gap to the nearest other snake's body point, head (counted 5 ticks of its movement
  closer, since it can turn toward you) or the road that head drives over the next 2 s on its
  current heading. The first spot with 10 units of room (`spawnClearance`) is taken. The snake
  faces the one of 16 headings whose straight road over 2 s keeps the most room (other snakes and
  the wall), the centre when several have 10 units, with its body laid out straight behind it.
- For its first **15 ticks** (1.5 s, `spawnGraceTicks`) a new snake is in **spawn grace**; see
  [Collisions](#collisions-and-death).

## Mass, size and body

A snake's **mass** (called `length` in the bot state) drives everything else:

| Quantity             | Formula                                    | At start (mass 10) |
| -------------------- | ------------------------------------------ | ------------------ |
| size (segment gap)   | `1 + 4 × mass / 10000`, capped at 5        | 1.004              |
| body radius          | `size / 2`                                 | 0.502              |
| segments (with head) | `floor(mass × 0.1 / size + 5)`, at least 1 | 5                  |
- Size reaches its cap of 5 (radius 2.5) at mass 10 000.
- The body is a chain of points `size` apart along the path the head travelled, head first. A
  growing snake unfolds from the tail.
- Mass never drops below 0 (`minMass`). A snake at mass 0 does not die of it; it just stays tiny.

## Movement and turning

Every tick, in this order, each snake:

1. **Turns.** The heading changes by `−turn × turnRate`, with `turnRate` = **0.4 rad per tick**
   (about 23°). `turn` is your action's value in [−1, 1]: negative turns left (counter-clockwise),
   positive turns right (clockwise).
2. **Moves** forward along the new heading by `speed`: **1.5** units per tick, **3** while
   boosting.

So a snake can't stop or reverse. At full turn it describes a circle of radius
`speed / turnRate` = **3.75** units (7.5 while boosting), and a U-turn takes 8 ticks. (Until
#98 `turnRate` was 0.25: radius 6, 12 while boosting. Rooms and replays keep the rules they
started with, see [Rule changes](#rule-changes).)

### Turn quantization (1/128)

The engine rounds `turn` to the nearest multiple of **1/128** before applying it, so replays can
store each turn in about a byte (`quantizeTurn` and `TURN_STEPS` in
[`step.ts`](../packages/engine/src/step.ts)):

- values are first clamped to [−1, 1]; `NaN` and non-numbers count as `0`;
- then `Math.round(turn × 128) / 128`, so `0.3` becomes `0.296875`. Very small turns go straight:
  anything above −1/256 and below +1/256 becomes `0`. `Math.round` rounds halves up, so exactly
  +1/256 becomes +1/128 while −1/256 becomes `0`;
- 0.5, 0.25 and other multiples of 1/128 stay exact.

Your bot sees the result only through its heading on the next tick. If you simulate your own
movement ahead of time, quantize the same way or you will drift slightly.

## Boost

- An action with `boost: true` boosts this tick if the snake's mass is at least **5**
  (`boostMinMass`). Below that, the request is ignored.
- A boosted tick moves at double speed and burns **1** mass (`boostCost`, never below 0).
- All the burned mass is dropped as a food pellet at the tail (`boostDropRatio` 1), unless the
  arena already holds 3000 pellets.

## Hunger

After moving (and boosting), every snake loses `0.002 + 0.0003 × mass` mass per tick
(`hungerFlat`, `hungerRate`). At mass 100 that is 0.032 per tick; at mass 1000, about 0.3. Big
snakes have to keep eating to stay big, so circling in a corner doesn't pay.

## Food

| Kind      | Value                           | Pellet radius | Where it appears                      |
| --------- | ------------------------------- | ------------- | ------------------------------------- |
| `ambient` | 1                               | 0.5           | uniformly at random in [−87.2, 87.2]² |
| `boost`   | the mass burned (1)             | 0.5           | at a boosting snake's tail            |
| `remains` | up to 10 (more above mass ~380) | 1.5           | along the body of a snake that died   |
- **Ambient food** spawns, at most 4 pellets per tick, while the arena holds fewer than
  `150 + 40 × living snakes` pellets (at most 3000). Pellets of every kind count toward that
  target, so remains and boost drops hold ambient spawning back. A new world starts with 150.
- **Eating**: a pellet is eaten when its distance from your head is less than `size × 3 +` its
  radius **and** it lies in a forward cone within 60° of your heading (`cos > 0.5`). Food beside or
  behind your head is not eaten until you turn toward it.
- A pellet two snakes could eat goes to the nearer head (the snake that spawned earlier on an exact
  tie).
- Eating happens after collisions, so a snake that dies this tick eats nothing.
- Bots only see the pellet's position and `value`, not its kind. Remains are eaten from farther
  away (their radius is 1.5). Ambient and boost pellets are always worth 1 (boost needs mass 5, so
  it always burns a full 1), so a `value` other than 1 means remains; remains worth exactly 1 are
  rare but possible.

## Collisions and death

Collisions are resolved **simultaneously**, on the positions after every snake has moved, and
**continuously** along each head's path during the tick. For each snake, the earliest thing its
head touches during its move is what kills it.

- **Body.** You die when your head circle touches a body point of another snake (any segment after
  its head), i.e. when the centre distance is at most `your radius + its radius`. The kill goes to
  that snake.
- **Head-on.** When two heads touch, the snake with **less mass dies** and the kill goes to the
  other. With **equal mass both die**, and each is credited with killing the other. A head-on
  contact between two snakes also cancels any body contact between the same two that tick, so the
  bigger snake doesn't die by brushing the smaller one's body as it eats it. Masses are compared
  **after** this tick's boost and hunger, so boosting into a head-on against an equal snake loses
  it.
- **Wall.** You die when your head point ends a tick outside the square, i.e. when
  `max(|x|, |y|) > 89` and `state.wallDistance` would drop below 0. Your body radius doesn't count
  here. Corners are the dangerous spots: heading into one, a snake has two walls to turn away from.
- **Spawn grace.** For its first 15 ticks a new snake takes no part in snake-to-snake collisions:
  heads pass through its body and its head passes through bodies and heads, so it can't kill and
  can't be killed by another snake. The wall still kills it, and it eats as usual. Bots see the
  ticks left as `spawnGrace` (on `self` and on every visible snake). When it runs out its body is
  solid again, wherever it lies.
- **Your own body** never kills you.
- A snake that dies this tick still kills others: its body and head stay in place for this tick's
  collisions.

### Causes of death

| Cause       | What happened                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| `collision` | head touched another snake's body, or lost (or tied) a head-on                                                          |
| `wall`      | head crossed the arena edge                                                                                             |
| `timeout`   | the bot went over its per-tick budget 3 ticks in a row, or over its load budget (see [Limits](limits.md))               |
| `error`     | the bot threw 3 ticks in a row, failed to load (rejected source, an exception, top-level `await`), or ran out of memory |
| `retired`   | the life reached the 24-hour life cap (not a failure: the score is kept), or the platform stopped it (see below)        |

`timeout` and `error` are decided by the sandbox before the tick is simulated: the snake dies
where it stands without moving.

When a snake dies for any reason, **all its mass** is dropped as `remains` pellets spread evenly
along its body from head to tail: `ceil(mass / 10)` pellets of equal value, but at least one per
two body segments and never more than one per segment, each moved by up to half a segment gap in
x and y (and kept within 87.2 of the centre on both axes, so remains of a snake that died at the
wall can still be eaten). So a newborn (mass 10, 5 segments) drops 3 pellets of about 3.3, pellets
are worth less than 10 below mass ~40, 10 at most up to mass ~380, and more for big ones above it,
where the segment cap takes over (mass 1000 drops 76 pellets of about 13). (Until #101 small
snakes dropped as few as one pellet, on the head; rooms and replays from before keep that.)

## Life cap

A life lasts until the snake dies. As a safety cap, a snake still alive after **864 000 ticks**
(`lifeCap`, 24 hours of game time) **retires**; the bot is told this as `info.maxLifeTicks`.
Reaching the cap is the best possible end of a life: nothing is lost, and the site shows it as
"Finished: reached the 24-hour life cap". Rooms run faster than real time while nobody watches,
so a 24-hour life usually takes a few hours of wall time. (Until the change to long lives the cap
was 6000 ticks, 10 minutes; rooms and replays from before keep it, see
[Rule changes](#rule-changes).)

The same `retired` cause also ends a life the platform stops: its version was rolled back,
archived or banned, or the arena was paused. The site shows that as "Stopped by the arena", and
such a life isn't rated (a capped one is).

## Score

A life's score is

```text
score = 0.001 × (sum of your mass over every tick you were alive) + 50 × kills
```

(`massScoreFactor` 0.001, `killBonus` 50; `lifeScore` in
[`growth.ts`](../packages/engine/src/growth.ts)). It is the area under your mass curve plus a
bonus per kill:

- staying at mass 100 for 1000 ticks earns 100 points, the same as 2 kills;
- staying at mass 100 for a minute (600 ticks) earns 60, so mass 100 is worth 60 points per
  minute alive;
- dying early ends the sum, so survival matters as much as size.

Your [rating](rating.md) is your score per minute alive over your recent lives: total score
divided by total time alive, so a long life weighs as much as the minutes it lasted.

## Order of one tick

From the comment on `step()` in [`step.ts`](../packages/engine/src/step.ts):

1. Sandbox faults (`timeout` / `error`) kill their snakes where they stand.
2. Every other snake turns, boosts (burning mass and dropping food at its tail), moves, pays
   hunger and re-lays its body.
3. Collisions are resolved on the new positions; the earliest contact of each head wins.
4. Survivors eat food in their forward cone.
5. Survivors age and score; those at the life cap (24 hours) retire.
6. The dead are credited to their killers and drop remains; ambient food tops up.

Your bot is called **before** each tick with what it sees at that moment (see
[Bot API](bot-api.md)), and its action is applied in step 2.

## Rooms

A room always runs 20 snakes, at most one per author. Real bots' lives come first; house bots
(`easy`, `medium`, `hard`, `chaos`, in an even mix) fill every slot they don't use, so a room with
three real bots runs with seventeen house bots. Several copies of one house bot can share a room,
each with its own name (`house:medium`, `house:medium#2`, ...). This is the design in
[SPEC.md](../SPEC.md) §4.

Real bots always take priority. When a snake dies, the room takes the next life from the queue;
if nobody is waiting, a house bot takes the slot. When a life is waiting and the room has no empty
slot, a house bot gives its slot up and is retired at once: the smallest house snake, so the room
changes as little as possible (the youngest of equally small ones). House bots' lives are not
rated and don't count toward any quota.

The queue takes turns: each bot has one life at a time, and when it ends the bot's next life goes
to the back of the queue, so every bot plays before any plays again. A bot whose author is already
in a room keeps its place for the next room with a free slot. A slot a house bot holds counts as
free, so waiting lives go into the open rooms first, taking over from house bots; new rooms open
only when more than 10 lives wait (or lives wait and no room is open), at most 4 at a time and
200 in all. A room closes when only house bots are left in it and the queue is empty. A bot plays
up to 100 lives per UTC day (see [Limits](limits.md#bundle-and-deploy-limits)); after that it
waits for the next day. Rolling back, archiving, a ban or a quarantine take effect within seconds,
and lives of a version that can no longer play are retired (`retired`, shown as "Stopped by the
arena", not rated). A life lasts until the snake dies, so a strong bot keeps
its slot for hours, and its next life queues only once this one ends.

## Rule changes

The defaults above can be tuned (e.g. `turnRate` went from 0.25 to 0.4 in #98). A room keeps the
rules it started with: its world and its replays carry its config, so a replay always plays back
on the rules it was recorded on, and a bot sees that room's values (`state.self.turnRate` and
`speed`, `info.worldHalfSize`, ...).
When the defaults change, rooms started before take no new lives, let the running ones finish on
the old rules, then close; every new room starts on the new ones. That is one more reason to read
the numbers from `info` and `state` instead of hard-coding them.
