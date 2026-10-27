import type { LifeEntry } from "./store.ts";

/** House bots fill rooms in this order, so a room gets a mix of strengths. */
export const HOUSE_FILL_ORDER = ["medium", "easy", "hard", "chaos"] as const;

/**
 * House bots to add so the room has at least `minAuthors` distinct authors (SPEC §4), without
 * going over `maxSnakes`. Each house bot is its own author (`house:<kind>`, then
 * `house:<kind>#2`, …), so the one-snake-per-author rule holds for them too. Ids depend only on
 * the tick and the lives present, so a replayed batch spawns the same snakes; they skip ids
 * already present (a second fill at the same tick, e.g. after an eviction).
 */
export function houseFill(
  present: readonly (Pick<LifeEntry, "author"> & Partial<Pick<LifeEntry, "lifeId">>)[],
  maxSnakes: number,
  minAuthors: number,
  tick: number,
): LifeEntry[] {
  const authors = new Set(present.map((p) => p.author));
  const ids = new Set(present.map((p) => p.lifeId));
  let seq = 0;
  const out: LifeEntry[] = [];
  for (let n = 0; authors.size < minAuthors && present.length + out.length < maxSnakes; n++) {
    const kind = HOUSE_FILL_ORDER[n % HOUSE_FILL_ORDER.length] as string;
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
