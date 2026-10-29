// How an arena room fills seats and sizes batches, ported verbatim from RoomDO (PR #56):
// `houseFill`, `houseToRetire` and `HOUSE_FILL_ORDER` from apps/arena/src/room/house.ts,
// `batchTicks` and its constants from apps/arena/src/limits.ts. A check room must follow the same rules, or a bot
// could tell the two apart. Until these live in a package both import, keep them in sync by
// hand: room-rules.test.ts pins their output.
import { DEFAULT_OP_BUDGET } from "@zerosnake/sandbox";

/** House bots fill rooms in this order, so a room gets a mix of strengths. */
export const HOUSE_FILL_ORDER = ["medium", "easy", "hard", "chaos"] as const;
export type HouseKind = (typeof HOUSE_FILL_ORDER)[number];

/** Snakes in a room; house bots fill every slot deployed bots don't use. */
export const DEFAULT_MAX_SNAKES = 20;

export interface HouseEntry {
  lifeId: string;
  author: string;
  house: HouseKind;
}

/**
 * House bots to add so the room holds `fillTo` snakes (SPEC §4: every free slot, so `fillTo` is
 * the room's `maxSnakes`). Each one is of the kind the room has fewest of, ties in
 * `HOUSE_FILL_ORDER`. Each house bot is its own author (`house:<kind>`, then `house:<kind>#2`,
 * …), so the one-snake-per-author rule holds for them too. Ids depend only on the tick, so a
 * replayed batch spawns the same snakes.
 */
export function houseFill(
  present: readonly { author: string }[],
  fillTo: number,
  tick: number,
): HouseEntry[] {
  const authors = new Set(present.map((p) => p.author));
  const kinds = new Map<HouseKind, number>(HOUSE_FILL_ORDER.map((k) => [k, 0]));
  for (const p of present) {
    const kind = /^house:([a-z]+)(#\d+)?$/.exec(p.author)?.[1] as HouseKind | undefined;
    if (kind !== undefined && kinds.has(kind)) kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  const out: HouseEntry[] = [];
  while (present.length + out.length < fillTo) {
    let kind: HouseKind = HOUSE_FILL_ORDER[0];
    for (const k of HOUSE_FILL_ORDER) if ((kinds.get(k) ?? 0) < (kinds.get(kind) ?? 0)) kind = k;
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    let author = `house:${kind}`;
    for (let copy = 2; authors.has(author); copy++) author = `house:${kind}#${copy}`;
    authors.add(author);
    out.push({ lifeId: `house-${kind}-${tick}-${out.length}`, author, house: kind });
  }
  return out;
}

/**
 * The `count` house snakes that give their slots to deployed bots' lives (user lives take
 * priority): the smallest first, then the youngest, then by id.
 */
export function houseToRetire(
  house: readonly { lifeId: string; mass: number; startTick: number }[],
  count: number,
): string[] {
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

const DO_CPU_LIMIT_MS = 30_000;
const BATCH_CPU_SHARE = 0.5;
const WORST_MS_PER_OP = 0.9 + 1.7;
const STATE_MS = 1;
const WORST_BOT_TICK_MS = DEFAULT_OP_BUDGET * WORST_MS_PER_OP + STATE_MS;
const INIT_OP_BUDGET = 100;
const WORST_LIFE_START_MS = 7 + INIT_OP_BUDGET * WORST_MS_PER_OP;
const ENGINE_TICK_MS = 2;
const HOUSE_BOT_TICK_MS = 0.25;
const HOUSE_LIFE_START_MS = 1;
const BATCH_OVERHEAD_MS = 1_000;
const MAX_BATCH_TICKS = 500;

/**
 * Ticks for the next batch of an accelerated room: the most whose worst case (every sandboxed bot
 * at its full budget every tick, plus starting `lifeStarts` sandboxed lives; `houseBots` native
 * house bots and `houseStarts` house lives at their own cost) stays within `BATCH_CPU_SHARE` of
 * the DO CPU limit.
 */
export function batchTicks(
  bots: number,
  lifeStarts: number,
  cpuLimitMs = DO_CPU_LIMIT_MS,
  houseBots = 0,
  houseStarts = 0,
): number {
  const budget =
    cpuLimitMs * BATCH_CPU_SHARE -
    BATCH_OVERHEAD_MS -
    lifeStarts * WORST_LIFE_START_MS -
    houseStarts * HOUSE_LIFE_START_MS;
  const perTick = bots * WORST_BOT_TICK_MS + houseBots * HOUSE_BOT_TICK_MS + ENGINE_TICK_MS;
  return Math.max(1, Math.min(MAX_BATCH_TICKS, Math.floor(budget / perTick)));
}
