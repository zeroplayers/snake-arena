/** Which rooms the showcase shows (see `../showcase.ts`). Pure, so it is tested in Node. */

/** Rooms shown at once: the home page watches slot 0; slot 1 is there for a second view. */
export const SHOWCASE_SLOTS = 2;
/** How often a running room reports itself. */
export const SHOWCASE_REPORT_MS = 15_000;
/** A room that hasn't reported for this long is gone (crashed, evicted for good). */
export const SHOWCASE_STALE_MS = 3 * SHOWCASE_REPORT_MS;

/** A running room as it reports itself. */
export interface ShowcaseCandidate {
  /** `ROOMS` Durable Object id (`idFromString`), how the route reaches it. */
  objectId: string;
  roomId: string;
  tick: number;
  /** Snakes of deployed versions (house bots excluded). */
  realLives: number;
  snakes: number;
  /** Total mass of its snakes. */
  mass: number;
  spectators: number;
  /** Wall ms of the report. */
  at: number;
}

export interface ShowcaseRpc {
  report(candidate: ShowcaseCandidate): Promise<void>;
  /** The room closed. */
  remove(objectId: string): Promise<void>;
  /** The showcase rooms by slot (object ids), at most `SHOWCASE_SLOTS`. */
  rooms(): Promise<string[]>;
  /** Shows these rooms instead of the rule's choice; null goes back to the rule. */
  pin(objectIds: string[] | null): Promise<void>;
}

/**
 * The rule: `current` showcase rooms keep their slot while they're fresh and hold a deployed bot;
 * empty slots go to the best other rooms (most deployed bots, then most mass).
 */
export function pickShowcase(
  candidates: readonly ShowcaseCandidate[],
  current: readonly string[],
  now: number,
  slots = SHOWCASE_SLOTS,
): string[] {
  const eligible = new Map(
    candidates
      .filter((c) => now - c.at < SHOWCASE_STALE_MS && c.realLives > 0)
      .map((c) => [c.objectId, c]),
  );
  const picked = current.slice(0, slots).map((id) => (eligible.has(id) ? id : null));
  const rest = [...eligible.values()]
    .filter((c) => !picked.includes(c.objectId))
    .sort((a, b) => b.realLives - a.realLives || b.mass - a.mass);
  for (let i = 0; i < slots; i++) {
    if (picked[i] === null || picked[i] === undefined) picked[i] = rest.shift()?.objectId ?? null;
  }
  return picked.filter((id): id is string => id !== null);
}
