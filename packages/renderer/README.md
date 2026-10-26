# @zerosnake/renderer

three.js renderer for ZeroSnake Arena matches and replays, ported from the original ZeroSnake
(`ThreeJSRenderer`, `Player/Food/BackgroundRenderer`, default SVG skin) without Colyseus or React.

```bash
pnpm --filter @zerosnake/renderer dev   # demo with a fake world, http://localhost:5173
```

Demo keys: `O` overview, `F`/`Tab` follow next snake (`Shift` for previous), `Space` pause,
wheel or `+`/`-` to zoom.

## Input

The renderer takes `RenderFrame`s (`src/types.ts`), not engine types, so an engine adapter is
a plain mapping:

- `tick`, `arenaRadius` (disc centred at the origin)
- `snakes[]`: `id`, `segments` (head first, any spacing), `angle` (radians from +x), `length`,
  optional `radius` (half-width) and `skin: { id?, color? }`
- `food[]`: `x`, `y`, `size` (radius), optional `id` (enables grow-in / eaten animations) and `color`

Frames must be immutable snapshots: the renderer keeps a few to interpolate between.

## Use

```ts
const renderer = new ArenaRenderer(container, { tps: 10, camera: { mode: "overview" } });

// Live: push each tick; playback trails one tick and is interpolated to the display rate.
renderer.push(frame);
renderer.start();

// Replays / scrubbing: drive it yourself.
renderer.draw(prevFrame, nextFrame, alpha);

renderer.setCamera({ mode: "follow", snakeId, minViewRadius: 30 }); // keep 30 units in view
renderer.setHighlight({ snakeId, radius: 30, color: "#ff0000" }); // e.g. its vision radius
renderer.setZoom(1.5);
renderer.screenToWorld(event.clientX, event.clientY); // for picking
renderer.destroy();
```

The match viewer (timeline, snake list, logs) is built on top of this in `@zerosnake/viewer`.

Snake bodies are blended point by point between ticks and resampled at a fixed spacing, so
the look doesn't depend on how densely the engine samples segments. Sizes are tuned for the
original ZeroSnake scale (snakes ~1–5 units thick); `gridCellSize` and `borderWidth` adjust
the background for other scales.
