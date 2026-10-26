import type { EngineConfig } from "./config";
import { clamp } from "./math";

/**
 * Growth formulas ported from the original ZeroSnake
 * (`frontend/docs/snake_growth_simulation_guide.md`, `PlayerSystem.updatePlayerSize`), with the
 * original's `score` renamed to `mass`.
 */

/** Segment spacing: linear in mass from minSize, capped at maxSize. */
export function sizeForMass(mass: number, c: EngineConfig): number {
  return clamp(c.minSize + (c.maxSize - c.minSize) * (mass / c.sizeMassCap), c.minSize, c.maxSize);
}

/** Total segments including the head. Original: floor(score × MIN_SIZE / (size × 10) + 5). */
export function segmentCountForMass(mass: number, c: EngineConfig): number {
  const size = sizeForMass(mass, c);
  return Math.max(1, Math.floor((mass * c.segmentMassFactor) / size + c.baseSegments));
}

/** Mass after one tick of hunger. */
export function hungerDecay(mass: number, c: EngineConfig): number {
  return Math.max(c.minMass, mass - c.hungerFlat - mass * c.hungerRate);
}

/** Life score: area under the mass curve plus kill bonus. */
export function lifeScore(massArea: number, kills: number, c: EngineConfig): number {
  return massArea * c.massScoreFactor + kills * c.killBonus;
}
