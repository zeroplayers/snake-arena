import { stateHash } from "../hash.ts";

/** Hex {@link stateHash}: bit-identical structures (0 vs -0 included) give equal strings. */
export function fingerprint(value: unknown): string {
  return stateHash(value).toString(16);
}
