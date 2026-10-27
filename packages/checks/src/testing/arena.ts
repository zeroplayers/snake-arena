import { createSandbox, DEFAULT_OP_BUDGET } from "@zerosnake/sandbox";
import { CostMeter } from "../cost.ts";
import type { Disguise, Identity } from "../disguise.ts";
import { type MatchResult, playMatch } from "../match.ts";
import type { HouseKind } from "../room-rules.ts";

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * A Better Auth user id, made the way Better Auth makes them (crypto random, 32 of a-z, A-Z,
 * 0-9), not with the check's own generator.
 */
function betterAuthId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

function arenaIdentity(): Identity {
  const author = betterAuthId();
  const ids: string[] = [];
  return {
    author,
    lifeId(n) {
      while (ids.length <= n) ids.push(crypto.randomUUID());
      return ids[n] as string;
    },
  };
}

/**
 * Plays `bundle` in a room set up as the arena sets one up, to compare with the check: the room
 * opens at tick 0, like every RoomDO (#56), with deployed bots under Better Auth user ids. The
 * candidate's ticket arrives after `preroll` ticks; 0 means it opened the room.
 */
export async function playInArena(
  bundle: string,
  { seed, ticks, preroll }: { seed: number; ticks: number; preroll: number },
): Promise<MatchResult> {
  const sandbox = await createSandbox();
  const unlimited = { maxMillis: Infinity, maxInterrupts: Infinity, maxWork: Infinity };
  const meter = new CostMeter(unlimited, () => performance.now());
  const users: HouseKind[] = ["medium", "easy", "hard"];
  const disguise: Disguise = {
    startTick: 0,
    preroll,
    candidate: arenaIdentity(),
    users: users.map((kind) => ({ kind, identity: arenaIdentity() })),
  };
  return playMatch(
    { kind: "sandbox", sandbox, bundle, meter },
    { seed, ticks, opBudget: DEFAULT_OP_BUDGET },
    {},
    disguise,
  );
}
