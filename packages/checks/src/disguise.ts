// The check must not be recognisable from inside the bot, or a bot could play well only when it
// is being checked. So every value it can observe is shaped like the arena's, and derived from
// seeds the bot can't predict: they come from a hash of its own bundle (see `checkSeeds`).
import { createRng, type Rng } from "@zerosnake/engine";
import type { HouseBotName } from "@zerosnake/house-bots";

/** Lowest and highest world tick a check match starts at (rooms are persistent). */
const START_TICK = { min: 50_000, max: 5_000_000 };
/** Ticks the opponents play alone before the candidate joins, so the room looks lived in. */
const PREROLL = { min: 100, max: 600 };
/** Chance that an opponent is shown as a deployed bot of some author rather than a house bot. */
const DISGUISED_SHARE = 0.5;

/** How one seat is shown to the other bots. Ids change per life, the author never does. */
export interface Identity {
  author: string;
  /** The snake id of a life that starts at `tick` (`n`: index among the seat's spawns). */
  lifeId(tick: number, n: number): string;
}

export interface Disguise {
  /** `world.tick` when the opponents spawn. */
  startTick: number;
  /** Ticks before the candidate spawns. */
  preroll: number;
  candidate: Identity;
  opponents: Record<HouseBotName, Identity>;
}

/**
 * Names, start tick and pre-roll of one check match, derived from its seed. The shapes follow the
 * arena (#24): a deployed bot's snake id is its life id and its author the user id, both UUIDs;
 * a house bot is `house-<kind>-<tick>-<n>` by author `house:<kind>`.
 */
export function disguiseFor(seed: number, kinds: readonly HouseBotName[]): Disguise {
  // A stream of its own, so it doesn't shift the world's randomness.
  const rng = createRng((seed ^ 0x9e3779b9) >>> 0);
  const startTick = START_TICK.min + rng.int(START_TICK.max - START_TICK.min);
  const preroll = PREROLL.min + rng.int(PREROLL.max - PREROLL.min);
  const opponents = {} as Record<HouseBotName, Identity>;
  for (const kind of kinds) {
    opponents[kind] = rng.next() < DISGUISED_SHARE ? userIdentity(rng) : houseIdentity(kind);
  }
  return { startTick, preroll, candidate: userIdentity(rng), opponents };
}

function houseIdentity(kind: string): Identity {
  return { author: `house:${kind}`, lifeId: (tick) => `house-${kind}-${tick}-0` };
}

/** A deployed bot: a user id for the author, a fresh life id per spawn (all from `rng`). */
function userIdentity(rng: Rng): Identity {
  const author = uuid(rng);
  const lives = rng.fork();
  const ids: string[] = [];
  return {
    author,
    lifeId(_tick, n) {
      while (ids.length <= n) ids.push(uuid(lives));
      return ids[n] as string;
    },
  };
}

/** A version 4 UUID, like `crypto.randomUUID()`, from `rng`. */
export function uuid(rng: Rng): string {
  const b = Array.from({ length: 16 }, () => rng.int(256));
  b[6] = ((b[6] as number) & 0x0f) | 0x40;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const hex = b.map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The seeds a bundle is checked on: the first `count` 32-bit words of SHA-256(bundle). The same
 * bundle always gets the same seeds (CLI and server agree), but a bot can't know them, since
 * they depend on its own text, so it can't recognise a check match by its seed or its world.
 */
export async function checkSeeds(bundle: string, count: number): Promise<number[]> {
  if (count > 8) throw new RangeError("SHA-256 gives at most 8 seeds");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bundle)),
  );
  const view = new DataView(digest.buffer);
  return Array.from({ length: count }, (_, i) => view.getUint32(i * 4));
}
