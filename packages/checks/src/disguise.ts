// The check must not be recognisable from inside the bot, or a bot could play well only when it
// is being checked. So the room runs by the arena's own rules (`room-rules.ts`), every name is
// shaped like the arena's, and everything is derived from seeds the bot can't predict: they come
// from a hash of its own bundle (see `checkSeeds`).
import { createRng, type Rng } from "@zerosnake/engine";
import { HOUSE_FILL_ORDER, type HouseKind } from "./room-rules.ts";

/** Lowest and highest world tick a check room starts at (rooms are persistent). */
const START_TICK = { min: 50_000, max: 5_000_000 };
/** Ticks the room runs before the candidate's ticket arrives, so it joins a room in progress. */
const PREROLL = { min: 100, max: 600 };
/** Most house bots shown as some author's deployed bot instead (the rest come from the fill). */
const MAX_USERS = 3;

/** A deployed bot: one author (a user id), a fresh life id per life. */
export interface Identity {
  author: string;
  /** The snake id of this seat's `n`-th life (0-based). */
  lifeId(n: number): string;
}

export interface Disguise {
  /** `world.tick` when the room opens. */
  startTick: number;
  /** Ticks after which the candidate's ticket arrives (it joins at the next batch). */
  preroll: number;
  candidate: Identity;
  /**
   * Other "deployed bots" in the room: house bots under user names. They are tickets like the
   * candidate's, so they join before the house fill and rejoin at the next batch after a death.
   */
  users: { kind: HouseKind; identity: Identity }[];
}

/**
 * Start tick, pre-roll and identities of one check room, derived from its seed. The shapes follow
 * the arena (RoomDO, #56): a deployed bot's snake id is its life id and its author the user id,
 * both UUIDs. House bots are named by `houseFill` itself.
 */
export function disguiseFor(seed: number): Disguise {
  // A stream of its own, so it doesn't shift the world's randomness.
  const rng = createRng((seed ^ 0x9e3779b9) >>> 0);
  const startTick = START_TICK.min + rng.int(START_TICK.max - START_TICK.min);
  const preroll = PREROLL.min + rng.int(PREROLL.max - PREROLL.min);
  const kinds: HouseKind[] = [...HOUSE_FILL_ORDER];
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [kinds[i], kinds[j]] = [kinds[j] as HouseKind, kinds[i] as HouseKind];
  }
  const users = kinds
    .slice(0, rng.int(MAX_USERS + 1))
    .map((kind) => ({ kind, identity: userIdentity(rng) }));
  return { startTick, preroll, candidate: userIdentity(rng), users };
}

/** A user id for the author and a fresh life id per spawn, all from `rng`. */
function userIdentity(rng: Rng): Identity {
  const author = uuid(rng);
  const lives = rng.fork();
  const ids: string[] = [];
  return {
    author,
    lifeId(n) {
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
