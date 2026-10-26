/**
 * Room-strength normalization (SPEC §4: "normalize by the room's average rating"). Off by
 * default; see the package README for what the simulation says about turning it on.
 *
 *   adjusted = score × clamp((strength / reference) ^ alpha, 1 / maxFactor, maxFactor)
 *
 * A life played among stronger opponents than `reference` is scaled up, among weaker ones down.
 * `alpha` is the elasticity of score to room strength with the sign flipped: if doubling the
 * opponents' rating halves a bot's score, `alpha = 1` cancels it exactly.
 */
export interface NormalizationConfig {
  enabled: boolean;
  /**
   * Room strength at which a score is left as it is. Keep it fixed (e.g. the house bots' mean
   * rating): a drifting reference makes lives scored at different times incomparable.
   */
  reference: number;
  alpha: number;
  /** Bound on the factor either way, so one odd room can't swing a life far. */
  maxFactor: number;
}

export const DEFAULT_NORMALIZATION: Readonly<NormalizationConfig> = Object.freeze({
  enabled: false,
  reference: 500,
  alpha: 0.5,
  maxFactor: 2,
});

/** One opponent the life shared the room with. */
export interface RoomMember {
  /** Its rating (`Rating.mean`) when the life started, `null` if it has none yet. */
  rating: number | null;
  /** How long it was there, e.g. ticks overlapping the life; default 1. */
  weight?: number;
}

/**
 * The room's strength for one life: the weighted mean rating of the *other* snakes. Unrated
 * snakes count as `unrated` (the reference is a reasonable choice). An empty room is
 * `unrated` too.
 */
export function roomStrength(members: readonly RoomMember[], unrated: number): number {
  let total = 0;
  let weights = 0;
  for (const m of members) {
    const w = m.weight ?? 1;
    if (!(w > 0)) continue;
    total += w * (m.rating ?? unrated);
    weights += w;
  }
  return weights > 0 ? total / weights : unrated;
}

/** `score` adjusted for `strength`; returns `score` unchanged when normalization is off. */
export function normalizeScore(
  score: number,
  strength: number,
  config: NormalizationConfig = DEFAULT_NORMALIZATION,
): number {
  if (!config.enabled || !(strength > 0) || !(config.reference > 0)) return score;
  const factor = (strength / config.reference) ** config.alpha;
  return score * Math.min(config.maxFactor, Math.max(1 / config.maxFactor, factor));
}
