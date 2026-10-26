/**
 * Render input. Deliberately independent of `@zerosnake/engine` internals: a thin adapter
 * maps the engine's world (or a replay / spectator message) onto these shapes.
 *
 * Units are world units. The look is tuned for the original ZeroSnake scale, where a snake
 * is roughly 1–5 units thick; see `RendererOptions.gridCellSize` if the engine uses another.
 */

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export interface SnakeSkin {
  /** Skin id from `SKINS`; unknown ids fall back to `"default"`. */
  readonly id?: string;
  /** Outer colour of the skin, `#rrggbb`. */
  readonly color?: string;
}

export interface RenderSnake {
  readonly id: string;
  /** Body points, head first. Spacing is up to the engine; the renderer resamples. */
  readonly segments: readonly Vec2[];
  /** Heading of the head, radians, counter-clockwise from +x. */
  readonly angle: number;
  /** Snake length as the engine counts it; drives the follow-camera zoom. */
  readonly length: number;
  /** Body half-width. Defaults to a value derived from `length`. */
  readonly radius?: number;
  readonly skin?: SnakeSkin;
}

export interface RenderFood {
  /** Stable id; enables the "eaten" animation. Without it food just pops in and out. */
  readonly id?: string | number;
  readonly x: number;
  readonly y: number;
  /** Radius of the food dot. */
  readonly size: number;
  /** `#rrggbb`; picked from a palette by id when omitted. */
  readonly color?: string;
}

/** One simulation tick, as the renderer sees it. */
export interface RenderFrame {
  readonly tick: number;
  /** The arena is a disc of this radius centred at the origin. */
  readonly arenaRadius: number;
  readonly snakes: readonly RenderSnake[];
  readonly food: readonly RenderFood[];
}

export type CameraMode =
  | { readonly mode: "overview" }
  | { readonly mode: "follow"; readonly snakeId: string };
