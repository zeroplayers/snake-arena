import { type LifeEnding, lifeCapName } from "../shared/lives";

// Fixed zone so the server render and hydration agree.
const dateFormat = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeZone: "UTC",
});
const dateTimeFormat = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
  hourCycle: "h23",
});

export const formatDate = (iso: string) => dateFormat.format(new Date(iso));
export const formatDateTime = (iso: string) => `${dateTimeFormat.format(new Date(iso))} UTC`;

/** `62.3 ± 4.1`: a rating, in points per minute alive. */
export function formatRating(mean: number | null, ci?: number | null) {
  if (mean === null) return "—";
  return ci === null || ci === undefined
    ? mean.toFixed(1)
    : `${mean.toFixed(1)} ± ${ci.toFixed(1)}`;
}

/** Game time at 10 ticks per second: `1:05`, `2:03:05` from an hour on. */
export function formatTicks(ticks: number | null, tps = 10) {
  if (ticks === null) return "—";
  const s = Math.round(ticks / tps);
  const ss = String(s % 60).padStart(2, "0");
  if (s < 3600) return `${Math.floor(s / 60)}:${ss}`;
  const mm = String(Math.floor(s / 60) % 60).padStart(2, "0");
  return `${Math.floor(s / 3600)}:${mm}:${ss}`;
}

/** Minutes of game time: `45 min`, `3 h 05 min`. */
export function formatMinutes(minutes: number) {
  const m = Math.floor(minutes);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/**
 * How a life ended (`lifeEnding` in `src/shared/lives.ts`: `retired` split into a life that
 * reached the cap and one the platform stopped), as a short label.
 */
export const LIFE_ENDINGS: Record<LifeEnding, string> = {
  collision: "collision",
  wall: "hit the wall",
  timeout: "timed out",
  error: "threw an error",
  capped: "reached the life cap",
  stopped: "stopped by the arena",
};

/** `LIFE_ENDINGS` for one life, naming the cap it reached (`24-hour`; `10-minute` before). */
export function endingLabel(ending: LifeEnding, ticks: number | null) {
  return ending === "capped" && ticks !== null
    ? `reached the ${lifeCapName(ticks)} life cap`
    : LIFE_ENDINGS[ending];
}

/**
 * The replay page's heading for a finished life. Only a death says "Died": a capped life is
 * "Finished: reached the 24-hour life cap", a stopped one "Stopped by the arena" (its version
 * stopped playing, or the arena was paused: `lives` doesn't say which).
 */
export function endingHeading(
  ending: LifeEnding,
  ticks: number | null,
): { verb: "Died" | "Finished" | "Stopped"; text: string; death: boolean } {
  switch (ending) {
    case "capped":
      return { verb: "Finished", text: endingLabel(ending, ticks), death: false };
    case "stopped":
      return { verb: "Stopped", text: "by the arena", death: false };
    default:
      return { verb: "Died", text: LIFE_ENDINGS[ending], death: true };
  }
}
