import type { LifeEntry } from "./store.ts";

/** House bots fill rooms in this order, so a room gets a mix of strengths. */
export const HOUSE_FILL_ORDER = ["medium", "easy", "hard", "chaos"] as const;

/** The kind of a house bot's author (`house:<kind>` or `house:<kind>#<n>`), else null. */
function houseKindOf(author: string): string | null {
  return /^house:([a-z]+)(#\d+)?$/.exec(author)?.[1] ?? null;
}

/**
 * House bots to add so the room holds `fillTo` snakes (SPEC §4: every free slot, so `fillTo` is
 * the room's `maxSnakes`). Each one is of the kind the room has fewest of, ties in
 * `HOUSE_FILL_ORDER`: an empty room fills medium, easy, hard, chaos, medium, …, and a dead house
 * snake's replacement keeps the mix even (always starting at medium would drift a full room
 * towards medium). Each house bot is its own author (`house:<kind>`, then `house:<kind>#2`, …),
 * so the one-snake-per-author rule holds for them too and every instance has a name of its own.
 * Ids depend only on the tick and the lives present, so a replayed batch spawns the same snakes;
 * they skip ids already present (a second fill at the same tick, e.g. after an eviction).
 */
export function houseFill(
  present: readonly (Pick<LifeEntry, "author"> & Partial<Pick<LifeEntry, "lifeId">>)[],
  fillTo: number,
  tick: number,
): LifeEntry[] {
  const authors = new Set(present.map((p) => p.author));
  const ids = new Set(present.map((p) => p.lifeId));
  const kinds = new Map<string, number>(HOUSE_FILL_ORDER.map((k) => [k, 0]));
  for (const p of present) {
    const kind = houseKindOf(p.author);
    if (kind !== null && kinds.has(kind)) kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  let seq = 0;
  const out: LifeEntry[] = [];
  while (present.length + out.length < fillTo) {
    let kind: string = HOUSE_FILL_ORDER[0];
    for (const k of HOUSE_FILL_ORDER) if ((kinds.get(k) ?? 0) < (kinds.get(kind) ?? 0)) kind = k;
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    let author = `house:${kind}`;
    for (let copy = 2; authors.has(author); copy++) author = `house:${kind}#${copy}`;
    authors.add(author);
    let lifeId = `house-${kind}-${tick}-${seq++}`;
    while (ids.has(lifeId)) lifeId = `house-${kind}-${tick}-${seq++}`;
    out.push({
      lifeId,
      versionId: null,
      author,
      house: kind,
      source: "",
    });
  }
  return out;
}

/** What `houseToRetire` needs of a snake in the room. */
export interface HouseCandidate {
  lifeId: string;
  /** Its mass in the saved world (0 if it has no snake yet). */
  mass: number;
  startTick: number;
}

/**
 * The `count` house snakes that give their slots to deployed bots' lives (SPEC §4: user lives
 * take priority): the smallest first, then the youngest, then by id. A small snake leaves the
 * least food behind and changes the room least, and the big ones are what spectators watch; the
 * order depends only on the saved world, so a rerun of the batch retires the same snakes.
 */
export function houseToRetire(house: readonly HouseCandidate[], count: number): string[] {
  if (count <= 0) return [];
  return [...house]
    .sort(
      (a, b) =>
        a.mass - b.mass ||
        b.startTick - a.startTick ||
        (a.lifeId < b.lifeId ? -1 : a.lifeId > b.lifeId ? 1 : 0),
    )
    .slice(0, count)
    .map((h) => h.lifeId);
}

/**
 * How a spectator sees a house bot: its kind, plus the instance number of a second or later copy
 * (`house:medium#2` → `medium #2`), so several instances of one kind are told apart.
 */
export function houseLabel(author: string, kind: string | null): string {
  const copy = /#(\d+)$/.exec(author)?.[1];
  const name = kind ?? "house";
  return copy ? `${name} #${copy}` : name;
}
