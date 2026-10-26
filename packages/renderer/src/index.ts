export { ArenaRenderer, type RendererOptions } from "./ArenaRenderer";
export {
  defaultSnakeRadius,
  FrameBuffer,
  type FrameSample,
  interpolateSnake,
  lerpAngle,
  resamplePolyline,
} from "./interpolate";
export { resolveSkin, SKINS, type SkinDefinition, SNAKE_PALETTE } from "./skins";
export type { CameraMode, RenderFood, RenderFrame, RenderSnake, SnakeSkin, Vec2 } from "./types";
