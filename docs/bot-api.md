# Bot API

A bot is one ES module whose default export has a `tick` function and, optionally, an `init`
function. The types and helpers come from `@zerosnake/sdk`
([`packages/sdk/src`](../packages/sdk/src)).

Sources: [`types.ts`](../packages/sdk/src/types.ts) (state, info, action),
[`bot.ts`](../packages/sdk/src/bot.ts) (`defineBot`), [`log.ts`](../packages/sdk/src/log.ts),
[`geometry.ts`](../packages/sdk/src/geometry.ts) (helpers),
[`packages/engine/src/vision.ts`](../packages/engine/src/vision.ts) (how state is built),
[`packages/sandbox/src/prelude.ts`](../packages/sandbox/src/prelude.ts) (how the sandbox calls your
bot).

```ts
import { defineBot, nearestFood, steerToward } from "@zerosnake/sdk";

export default defineBot({
  init(info) {
    // Once per life. Whatever you return is `mem` for every tick of this life.
    return { ticksChasing: 0 };
  },
  tick(state, mem, log) {
    // Once per tick. Return this tick's action.
    const food = nearestFood(state);
    if (!food) return { turn: 0 };
    mem.ticksChasing++;
    log("chasing", food.x, food.y);
    return { turn: steerToward(state.self, food) };
  },
});
```

`defineBot` only returns its argument; it exists for type inference. A plain object with the same
shape works too.

## Lifecycle

1. **Load.** At the start of every life the bundle is evaluated in a fresh sandbox. The default
   export must be an object (or function) with a `tick` function, and `init`, if present, must be
   a function.
2. **`init(info)`** is called once with the [`BotInfo`](#info-botinfo). It must return an object
   (returning nothing means `{}`). That object is your memory, `mem`.
3. **`tick(state, mem, log)`** is called once per tick until the snake dies. It must return an
   action object.

If loading or `init` throws, or `init` returns something that isn't an object, the life dies with
cause `error` right away. Loading plus `init` share one budget; going over it is a `timeout` death
(see [Limits](limits.md)).

## Action

```ts
interface BotAction {
  turn: number; // [-1, 1]: -1 full left, 0 straight, 1 full right
  boost?: boolean; // default false
}
```

- `turn` is clamped to [−1, 1]; `NaN` and non-numbers count as `0`. The engine then rounds it to a
  multiple of 1/128 (see [Rules: turn quantization](rules.md#turn-quantization-1128)).
- Positive `turn` is **right**, which **decreases** the heading angle (angles are
  counter-clockwise). Use the helpers below instead of working out the sign by hand.
- `boost` counts only if it is exactly `true`. It is ignored below mass 5.
- Returning anything that isn't an object (including `undefined`, e.g. a missing `return`) is an
  exception: this tick reuses your previous action and counts toward the 3-in-a-row `error` rule.

## Memory between ticks

- **Within a life, everything persists.** Each life gets its own QuickJS runtime, so both `mem`
  and your module's top-level variables keep their values from tick to tick. Mutate `mem` in
  place.
- **Between lives, nothing persists.** The next life loads the bundle again in a new runtime and
  calls `init` again.
- `state` is a fresh object every tick (it is parsed from JSON inside the sandbox). Keeping
  references to it is safe but they won't update.
- Memory counts toward the per-bot memory limit (see [Limits](limits.md)).

## Info (`BotInfo`)

Passed to `init` once per life. The values are the defaults; read them from `info` rather than
hard-coding them.

| Field           | Default | Meaning                                                                               |
| --------------- | ------- | ------------------------------------------------------------------------------------- |
| `snakeId`       |         | your snake's id for this life; equals `state.self.id`                                 |
| `worldRadius`   | 100     | the arena is a disc of this radius around (0, 0)                                      |
| `visionRadius`  | 40      | you see snake points and food at most this far from your head                         |
| `tickRate`      | 10      | ticks per second of game time (rooms may run faster in wall-clock time)               |
| `maxLifeTicks`  | 6000    | the life retires after this many ticks                                                |
| `opBudget`      | 10      | sandbox budget per `tick()` call, see [Limits](limits.md)                             |
| `logLimitBytes` | 1024    | `log()` bytes kept per tick                                                           |
| `seed`          |         | seed of this life's `Math.random()`; already applied, useful only to tell lives apart |

`opBudget` 10 is `DEFAULT_OP_BUDGET` in
[`packages/sandbox/src/sandbox.ts`](../packages/sandbox/src/sandbox.ts); `logLimitBytes` is
`LOG_LIMIT_BYTES` in [`log.ts`](../packages/sdk/src/log.ts); the rest comes from the engine config
(`buildBotInfo` in [`vision.ts`](../packages/engine/src/vision.ts)).

## State (`BotState`)

Passed to every `tick`. Plain JSON data.

| Field          | Meaning                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------- |
| `tick`         | the room's tick counter; keeps counting across lives (don't expect it to start at 0)      |
| `lifeTick`     | ticks since this life started; `0` on the first `tick()` call                             |
| `self`         | your snake, see below                                                                     |
| `snakes`       | other snakes with at least one point in vision, nearest first                             |
| `food`         | pellets in vision, nearest first: `{ x, y, value }`                                       |
| `wallDistance` | `worldRadius − distance of your head from the centre`; you die when it would drop below 0 |

### `self`

| Field      | Meaning                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------- |
| `id`       | same as `info.snakeId`                                                                            |
| `head`     | head position, `{ x, y }`; equals `segments[0]`                                                   |
| `angle`    | heading in radians, counter-clockwise from +x, in (−π, π]                                         |
| `length`   | your **mass** (not a segment count): grows by eating, shrinks with hunger and boost; drives score |
| `speed`    | distance moved last tick (1.5, or 3 when boosting)                                                |
| `radius`   | body radius (`size / 2`); collisions use it                                                       |
| `turnRate` | max heading change per tick at `turn = ±1` (0.25); read it, don't hard-code it                    |
| `boosting` | whether you boosted last tick                                                                     |
| `segments` | body points head to tail; at most 128, evenly downsampled, head and tail kept                     |

### `snakes[]` (`SnakeView`)

| Field      | Meaning                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------- |
| `id`       | unique in the room for that snake's life                                                     |
| `author`   | an opaque id of the bot's author (a user id in rooms); compare it, don't parse or display it |
| `length`   | the snake's full mass, even if you see only part of it                                       |
| `radius`   | its body radius                                                                              |
| `head`     | head position, or `null` if its head is outside your vision                                  |
| `angle`    | its heading, or `null` if its head is outside your vision                                    |
| `boosting` | whether it boosted last tick                                                                 |
| `segments` | only its points within your vision, head to tail; may have gaps and may be downsampled       |

Treat bodies as circles of `radius` around each point; the spacing between listed points is not
guaranteed.

**Authors.** `author` is an opaque id, the same for every snake of one account: for a real bot, its
owner's user id (a 32-character Better Auth id). House bots appear as `house:<kind>`
(`house:medium`, `house:easy#2`) in arena rooms, but the check suite shows some house opponents
under made-up ids in the same format as user ids. (The SDK's doc comment still calls `author` a
username.) Don't build strategy on recognising authors or house bots.

## Vision

You see a disc of radius `info.visionRadius` (40) around your head. A point is visible when its
distance from your head is at most that. The state is capped so copying it into the sandbox stays
cheap (`buildBotState` in [`vision.ts`](../packages/engine/src/vision.ts)):

| Cap                     | Default | What is kept                                                                             |
| ----------------------- | ------- | ---------------------------------------------------------------------------------------- |
| other snakes            | 32      | the nearest, by their nearest visible point                                              |
| points of other snakes  | 256     | over all snakes: each keeps its nearest point, the rest go to the nearest points overall |
| points of your own body | 128     | evenly spaced, head and tail included                                                    |
| food pellets            | 128     | the nearest                                                                              |

So in a crowd, nearby bodies are complete and only the far parts of the view are thinned out.

## `log()`

The third argument of `tick` works like `console.log`: arguments are joined with spaces, strings
print as they are, everything else as JSON (or `String()` if JSON fails). `console.log`, `.info`,
`.warn`, `.error` and `.debug` do the same inside the sandbox.

- Each call is one line. A tick keeps at most `info.logLimitBytes` (1024) UTF-8 bytes of lines.
  The line that would go over is cut at a character boundary and ends with `…`; every later call in
  that tick is dropped. The budget resets every tick.
- Inside the sandbox an empty line costs 1 byte.
- Lines logged before a timeout are kept.
- Logs show up in `zerosnake sim` (the viewer's snake panel) and in the arena's life traces: the
  last 100 ticks before a death in full, older ones downsampled, kept 7 days and visible only to
  the bot's owner (`zerosnake logs --deaths`, and under the replay on the site when signed in).

## Coordinates and angles

- Origin (0, 0) is the arena centre. `x` grows east (right), **`y` grows north (up)**, as in maths,
  not as on a screen.
- Angles are radians, counter-clockwise from +x: `0` east, `π/2` north, `−π/2` south, `π` west.
  `Math.atan2(dy, dx)` is the heading from one point to another.
- `turn > 0` turns right (clockwise, angle decreases); `turn < 0` turns left. Each tick the engine
  applies `angle −= quantized(turn) × turnRate`.
- Compare angles with `angleDiff`, never with `-`, which breaks across ±π.
- Units: positions and distances in world units, speed in units per tick, time in ticks.

## Helpers

All exported from `@zerosnake/sdk` ([`geometry.ts`](../packages/sdk/src/geometry.ts)). They have no
dependencies and run inside the sandbox.

| Helper                          | Returns                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `turnToward(self, angle)`       | the `turn` that rotates toward a heading as fast as allowed without overshoot |
| `steerToward(self, point)`      | the `turn` toward a point                                                     |
| `steerAway(self, point)`        | the `turn` directly away from a point                                         |
| `angleTo(from, to)`             | heading from one point to another                                             |
| `angleDiff(from, to)`           | signed smallest rotation, positive = counter-clockwise (left)                 |
| `normalizeAngle(a)`             | `a` wrapped into (−π, π]                                                      |
| `distance(a, b)`, `distanceSq`  | distance between points (squared)                                             |
| `distanceToWall(point, radius)` | distance from a point to the arena edge                                       |
| `project(origin, angle, dist)`  | the point `dist` ahead along `angle`                                          |
| `nearest(from, items)`          | the closest item of a list of points                                          |
| `nearestFood(state)`            | the closest visible pellet                                                    |
| `nearestDanger(state)`          | the closest visible point of another snake, with its `distance` and `gap`     |
| `clamp`, `CENTER`, `TAU`        | small utilities                                                               |

`gap` from `nearestDanger` is `distance − self.radius − snake.radius`: you die when it reaches 0.
