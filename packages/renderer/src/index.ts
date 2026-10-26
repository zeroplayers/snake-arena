export { ArenaRenderer, type RendererOptions } from "./ArenaRenderer.ts";
export {
  defaultSnakeRadius,
  FrameBuffer,
  type FrameSample,
  interpolateSnake,
  lerpAngle,
  resamplePolyline,
} from "./interpolate.ts";
export { resolveSkin, SKINS, type SkinDefinition, SNAKE_PALETTE } from "./skins/index.ts";
export type {
  CameraMode,
  Highlight,
  RenderFood,
  RenderFrame,
  RenderSnake,
  SnakeSkin,
  Vec2,
} from "./types.ts";
