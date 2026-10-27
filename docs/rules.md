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

- A disc of radius **100** centred on (0, 0). `x` grows east (right), `y` grows **north (up)**.
- Angles are radians, counter-clockwise from +x: `0` is east, `π/2` north. Headings are kept in
  (−π, π].
- A new snake spawns at a random spot within **80** of the centre (`arenaRadius × 0.8`), trying
  up to 30 spots for one at least 10 units from every other snake's body, then taking the last one
  tried. It faces the centre, with its body laid out straight behind it.

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

1. **Turns.** The heading changes by `−turn × turnRate`, with `turnRate` = **0.25 rad per tick**
   (about 14°). `turn` is your action's value in [−1, 1]: negative turns left (counter-clockwise),
   positive turns right (clockwise).
2. **Moves** forward along the new heading by `speed`: **1.5** units per tick, **3** while
   boosting.

So a snake can't stop or reverse. At full turn it describes a circle of radius
`speed / turnRate` = **6** units (12 while boosting), and a U-turn takes about 13 ticks.

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

| Kind      | Value               | Pellet radius | Where it appears                            |
| --------- | ------------------- | ------------- | ------------------------------------------- |
| `ambient` | 1                   | 0.5           | uniformly at random within 98 of the centre |
| `boost`   | the mass burned (1) | 0.5           | at a boosting snake's tail                  |
| `remains` | about 10 per pellet | 1.5           | along the body of a snake that died         |
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
- **Wall.** You die when your head point ends a tick farther than 100 from the centre, i.e. when
  `state.wallDistance` would drop below 0. Your body radius doesn't count here.
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
| `retired`   | the life reached the life cap (not a failure: the score is kept)                                                        |

`timeout` and `error` are decided by the sandbox before the tick is simulated: the snake dies
where it stands without moving.

When a snake dies for any reason, **all its mass** is dropped as `remains` pellets spread along its
body: `ceil(mass / 10)` pellets of equal value, but never more pellets than the body has segments,
each moved by up to half a segment gap in x and y. So pellets are worth at most 10 for small snakes
and more for big ones (above mass ~380 the segment cap takes over: mass 1000 drops 76 pellets of
about 13).

## Life cap

A life **retires** after **6000 ticks** alive (`lifeCap`), 10 minutes of game time. The bot is
told this as `info.maxLifeTicks`. Retiring is the best possible end of a life: nothing is lost.

## Score

A life's score is

```text
score = 0.001 × (sum of your mass over every tick you were alive) + 50 × kills
```

(`massScoreFactor` 0.001, `killBonus` 50; `lifeScore` in
[`growth.ts`](../packages/engine/src/growth.ts)). It is the area under your mass curve plus a
bonus per kill:

- staying at mass 100 for 1000 ticks earns 100 points, the same as 2 kills;
- a full life (6000 ticks) at mass 100 earns 600;
- dying early ends the sum, so survival matters as much as size.

Only the score of each life counts. Your [rating](rating.md) is the average over many lives.

## Order of one tick

From the comment on `step()` in [`step.ts`](../packages/engine/src/step.ts):

1. Sandbox faults (`timeout` / `error`) kill their snakes where they stand.
2. Every other snake turns, boosts (burning mass and dropping food at its tail), moves, pays
   hunger and re-lays its body.
3. Collisions are resolved on the new positions; the earliest contact of each head wins.
4. Survivors eat food in their forward cone.
5. Survivors age and score; those at the life cap retire.
6. The dead are credited to their killers and drop remains; ambient food tops up.

Your bot is called **before** each tick with what it sees at that moment (see
[Bot API](bot-api.md)), and its action is applied in step 2.

## Rooms

A room holds up to 20 snakes, at most one per author, and at least 5 different authors: house bots
fill the gap when there aren't enough real bots. When a snake dies, the room takes the next life
from the queue. This is the design in [SPEC.md](../SPEC.md) §4.

The queue takes turns: each bot has one life at a time, and when it ends the bot's next life goes
to the back of the queue, so every bot plays before any plays again. A bot whose author is already
in a room keeps its place for the next room with a free slot. New rooms open when lives pile up in
the queue; a room closes when only house bots are left in it and the queue is empty. A bot plays
up to 100 lives per UTC day (see [Limits](limits.md#bundle-and-deploy-limits)); after that it
waits for the next day. Rolling back, archiving, a ban or a quarantine take effect within seconds,
and lives of a version that can no longer play are retired (`retired`, not rated).
