import type { DeathCauseColumn } from "../db/schema";

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

/** `62.3 ± 4.1`. */
export function formatRating(mean: number | null, ci?: number | null) {
  if (mean === null) return "—";
  return ci === null || ci === undefined
    ? mean.toFixed(1)
    : `${mean.toFixed(1)} ± ${ci.toFixed(1)}`;
}

/** Game time at 10 ticks per second: `1:05`. */
export function formatTicks(ticks: number | null, tps = 10) {
  if (ticks === null) return "—";
  const s = Math.round(ticks / tps);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const DEATH_CAUSES: Record<DeathCauseColumn, string> = {
  collision: "collision",
  wall: "hit the wall",
  timeout: "timed out",
  error: "threw an error",
  retired: "retired (life cap)",
};
