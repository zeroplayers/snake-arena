/**
 * How a life ended, as the site, the CLI and the rating job tell it.
 *
 * `lives.death_cause` has one value for two different endings. `retired` is the engine's cause
 * for a life that reached the life cap (`lifeCap`: the best possible end, rated), and also what
 * the room writes for a life the platform stopped (`RoomRpc.leave`: its version was rolled back,
 * archived or banned, or the arena was paused; house snakes giving up their slot get it too, in
 * replays). Those aren't rated. The life's length tells them apart: the engine retires a snake on
 * the tick it is exactly `lifeCap` ticks old, so a retired life of exactly a cap's length reached
 * it. The arena has had two caps: 6000 ticks (10 minutes) until lives became long, 864 000
 * (24 hours) since. Rooms keep the rules they started with, so both appear in `lives`.
 *
 * (A version stopped on the very tick its life reached the cap would count as capped: harmless.)
 */
import { DEFAULT_CONFIG } from "@zerosnake/engine";

/** The 10-minute life cap rooms used before lives became long. */
export const LEGACY_LIFE_CAP_TICKS = 6000;
/** Every life cap the arena has used, in ticks. */
export const LIFE_CAPS: readonly number[] = [LEGACY_LIFE_CAP_TICKS, DEFAULT_CONFIG.lifeCap];

/** `lives.death_cause` (apps/web `schema.ts`). */
export type StoredDeathCause = "collision" | "wall" | "timeout" | "error" | "retired";

/**
 * `death_cause` with `retired` split: `capped` reached the life cap, `stopped` was ended by the
 * arena (its version was rolled back, archived, banned or quarantined, or the arena was paused;
 * `lives` doesn't say which, so the site says "Stopped by the arena").
 */
export type LifeEnding = Exclude<StoredDeathCause, "retired"> | "capped" | "stopped";

/** Whether a `retired` life of `ticks` ticks reached a life cap (else the platform stopped it). */
export function reachedLifeCap(cause: StoredDeathCause | null, ticks: number | null): boolean {
  return cause === "retired" && ticks !== null && LIFE_CAPS.includes(ticks);
}

/** How a life ended; `null` while it is alive. `ticks` is `end_tick − start_tick`. */
export function lifeEnding(
  cause: StoredDeathCause | null,
  ticks: number | null,
): LifeEnding | null {
  if (cause === null) return null;
  if (cause !== "retired") return cause;
  return reachedLifeCap(cause, ticks) ? "capped" : "stopped";
}

/** `24-hour` or `10-minute`: the cap a life of `ticks` reached, for labels. */
export function lifeCapName(ticks: number, tps = 10): string {
  const minutes = ticks / tps / 60;
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`;
}

/**
 * SQL condition over `lives` (aliased `l`): the life counts toward its version's rating as far
 * as how it ended goes. Every death counts, faults included; `retired` counts only at a cap.
 * (The rating job adds the stint condition.) Bind nothing: the caps are inlined.
 */
export const COUNTED_ENDING_SQL = `(l.death_cause IS NOT 'retired' OR l.end_tick - l.start_tick IN (${LIFE_CAPS.join(", ")}))`;
