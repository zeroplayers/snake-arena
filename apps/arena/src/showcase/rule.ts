/** Which rooms the showcase shows (see `../showcase.ts`). Pure, so it is tested in Node. */

/**
 * Rooms shown at once. The home page watches one; the route serves no other slot, so nobody can
 * put a second room into real time that no page shows.
 */
export const SHOWCASE_SLOTS = 1;
/**
 * The client a spectator's upgrade comes from, as the site's proxy saw it (its IP; an IPv6 /64).
 * Same name as `SHOWCASE_CLIENT_HEADER` in apps/web `src/server/showcase.ts`.
 */
export const SHOWCASE_CLIENT_HEADER = "x-showcase-client";
/** How often a running room reports itself. */
export const SHOWCASE_REPORT_MS = 15_000;
/** A room that hasn't reported for this long is gone (crashed, evicted for good). */
export const SHOWCASE_STALE_MS = 3 * SHOWCASE_REPORT_MS;
/**
 * Longest a room stays the showcase in one go. Its bots play in real time meanwhile, about ten
 * times slower than elsewhere, so its turn ends even while it is the best room.
 */
export const SHOWCASE_TURN_MS = 10 * 60_000;
/** After its turn a room rests this long: it isn't picked again, even if it's the only one. */
export const SHOWCASE_REST_MS = 20 * 60_000;

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

/** A showcase room and since when (wall ms) it has been one. */
export interface ShowcaseTurn {
  objectId: string;
  since: number;
}

export interface ShowcaseRpc {
  /** Whether the reporting room is a showcase room now (if not, it lets its spectators go). */
  report(candidate: ShowcaseCandidate): Promise<{ showcase: boolean }>;
  /** The room closed. */
  remove(objectId: string): Promise<void>;
  /** The showcase rooms by slot (object ids), at most `SHOWCASE_SLOTS`. */
  rooms(): Promise<string[]>;
  /**
   * Shows these rooms instead of the rule's choice; null goes back to the rule. Pinned rooms have
   * no turns: whoever pins them keeps them fair.
   */
  pin(objectIds: string[] | null): Promise<void>;
}

/**
 * The rule: `current` showcase rooms keep their slot while they're fresh, hold a deployed bot and
 * their turn (`SHOWCASE_TURN_MS`) lasts; a room whose turn ended rests (`SHOWCASE_REST_MS`).
 * Empty slots go to the best other rooms not resting (most deployed bots, then most mass), or
 * stay empty: the home page then plays its own match rather than slow down one room for good.
 *
 * `resting` maps object ids to when their rest ends; the result's `resting` drops rests that ended
 * and adds the rooms whose turn just ended.
 */
export function pickShowcase(
  candidates: readonly ShowcaseCandidate[],
  current: readonly ShowcaseTurn[],
  resting: Readonly<Record<string, number>>,
  now: number,
  slots = SHOWCASE_SLOTS,
): { turns: ShowcaseTurn[]; resting: Record<string, number> } {
  const rest: Record<string, number> = {};
  for (const [id, until] of Object.entries(resting)) if (until > now) rest[id] = until;
  const eligible = new Map(
    candidates
      .filter((c) => now - c.at < SHOWCASE_STALE_MS && c.realLives > 0)
      .map((c) => [c.objectId, c]),
  );
  const turns: (ShowcaseTurn | null)[] = current.slice(0, slots).map((t) => {
    if (!eligible.has(t.objectId)) return null;
    if (now - t.since < SHOWCASE_TURN_MS) return t;
    rest[t.objectId] = now + SHOWCASE_REST_MS;
    return null;
  });
  const taken = new Set(turns.flatMap((t) => (t ? [t.objectId] : [])));
  const next = [...eligible.values()]
    .filter((c) => !taken.has(c.objectId) && rest[c.objectId] === undefined)
    .sort((a, b) => b.realLives - a.realLives || b.mass - a.mass);
  for (let i = 0; i < slots; i++) {
    if (!turns[i]) {
      const c = next.shift();
      turns[i] = c ? { objectId: c.objectId, since: now } : null;
    }
  }
  return { turns: turns.filter((t): t is ShowcaseTurn => t !== null), resting: rest };
}
