// How an arena room fills seats and sizes batches, ported verbatim from RoomDO (PR #56):
// `houseFill` and `HOUSE_FILL_ORDER` from apps/arena/src/room/house.ts, `batchTicks` and its
// constants from apps/arena/src/limits.ts. A check room must follow the same rules, or a bot
// could tell the two apart. Until these live in a package both import, keep them in sync by
// hand: room-rules.test.ts pins their output.
import { DEFAULT_OP_BUDGET } from "@zerosnake/sandbox";

/** House bots fill rooms in this order, so a room gets a mix of strengths. */
export const HOUSE_FILL_ORDER = ["medium", "easy", "hard", "chaos"] as const;
export type HouseKind = (typeof HOUSE_FILL_ORDER)[number];

export const DEFAULT_MAX_SNAKES = 20;
export const DEFAULT_MIN_AUTHORS = 5;

export interface HouseEntry {
  lifeId: string;
  author: string;
  house: HouseKind;
}

/**
 * House bots to add so the room has at least `minAuthors` distinct authors (SPEC §4), without
 * going over `maxSnakes`. Each house bot is its own author (`house:<kind>`, then
 * `house:<kind>#2`, …), so the one-snake-per-author rule holds for them too. Ids depend only on
 * the tick, so a replayed batch spawns the same snakes.
 */
export function houseFill(
  present: readonly { author: string }[],
  maxSnakes: number,
  minAuthors: number,
  tick: number,
): HouseEntry[] {
  const authors = new Set(present.map((p) => p.author));
  const out: HouseEntry[] = [];
  for (let n = 0; authors.size < minAuthors && present.length + out.length < maxSnakes; n++) {
    const kind = HOUSE_FILL_ORDER[n % HOUSE_FILL_ORDER.length] as HouseKind;
    let author = `house:${kind}`;
    for (let copy = 2; authors.has(author); copy++) author = `house:${kind}#${copy}`;
    authors.add(author);
    out.push({ lifeId: `house-${kind}-${tick}-${out.length}`, author, house: kind });
  }
  return out;
}

const DO_CPU_LIMIT_MS = 30_000;
const BATCH_CPU_SHARE = 0.5;
const WORST_MS_PER_OP = 0.9 + 1.7;
const STATE_MS = 1;
const WORST_BOT_TICK_MS = DEFAULT_OP_BUDGET * WORST_MS_PER_OP + STATE_MS;
const INIT_OP_BUDGET = 100;
const WORST_LIFE_START_MS = 7 + INIT_OP_BUDGET * WORST_MS_PER_OP;
const ENGINE_TICK_MS = 2;
const BATCH_OVERHEAD_MS = 1_000;
const MAX_BATCH_TICKS = 500;

/**
 * Ticks for the next batch of an accelerated room: the most whose worst case (every bot at its
 * full budget every tick, plus starting `lifeStarts` lives) stays within `BATCH_CPU_SHARE` of the
 * DO CPU limit.
 */
export function batchTicks(bots: number, lifeStarts: number, cpuLimitMs = DO_CPU_LIMIT_MS): number {
  const budget =
    cpuLimitMs * BATCH_CPU_SHARE - BATCH_OVERHEAD_MS - lifeStarts * WORST_LIFE_START_MS;
  const perTick = bots * WORST_BOT_TICK_MS + ENGINE_TICK_MS;
  return Math.max(1, Math.min(MAX_BATCH_TICKS, Math.floor(budget / perTick)));
}
