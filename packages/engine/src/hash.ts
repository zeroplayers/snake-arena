import type { World } from "./types.ts";

/**
 * FNV-1a over every value in a structure, numbers by their IEEE-754 bits, so "equal" means
 * bit-identical (0 vs -0 included). Object keys are visited sorted, so key order doesn't matter.
 */
export function stateHash(value: unknown): number {
  const f64 = new Float64Array(1);
  const u32 = new Uint32Array(f64.buffer);
  let h = 0x811c9dc5;
  const mix = (x: number) => {
    h ^= x;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  const walk = (v: unknown): void => {
    if (typeof v === "number") {
      f64[0] = v;
      mix(1);
      mix(u32[0] as number);
      mix(u32[1] as number);
    } else if (typeof v === "string") {
      mix(2);
      for (let i = 0; i < v.length; i++) mix(v.charCodeAt(i));
    } else if (typeof v === "boolean") {
      mix(v ? 3 : 4);
    } else if (v === null || v === undefined) {
      mix(5);
    } else if (Array.isArray(v)) {
      mix(6);
      mix(v.length);
      for (const x of v) walk(x);
    } else if (typeof v === "object") {
      mix(7);
      for (const k of Object.keys(v).sort()) {
        walk(k);
        walk((v as Record<string, unknown>)[k]);
      }
    }
  };
  walk(value);
  return h;
}

/** 32-bit {@link stateHash} of the whole world: any difference in state almost surely changes it. */
export function hashWorld(world: World): number {
  return stateHash(world);
}
