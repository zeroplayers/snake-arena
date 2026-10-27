import type { EngineConfig, FoodKind } from "@zerosnake/engine";

/**
 * Drawn radius of a remains pellet relative to ambient food. The engine's `remainsRadius` (3×)
 * is a gameplay radius (it widens the eat reach); drawn at that size, a dead snake's pellets
 * become a string of blobs. Like slither.io, remains read as slightly bigger, valuable food.
 */
export const REMAINS_DISPLAY_SCALE = 1.6;

/**
 * Radius to draw a pellet of `kind` with (`RenderFood.size`). Presentation only: the engine's
 * radii, eat reach and values are untouched. Spectator broadcasts don't carry pellet values,
 * so the size depends on the kind alone and every source draws the same pellet the same way.
 *
 * Its own module so `apps/web`'s replay source can use it without pulling in three.js.
 */
export function foodDisplaySize(kind: FoodKind, config: Pick<EngineConfig, "foodRadius">): number {
  return kind === "remains" ? config.foodRadius * REMAINS_DISPLAY_SCALE : config.foodRadius;
}
