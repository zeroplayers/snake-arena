/**
 * Seeded PRNG (sfc32). The engine never touches Math.random, so a world is fully
 * reproducible from its seed and the bots' actions.
 */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform float in [min, max). */
  range(min: number, max: number): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
  /** Independent child stream, e.g. one per life. */
  fork(): Rng;
}

/** The four 32-bit words of an sfc32 stream, as plain data so a world can be cloned or stored. */
export type RngState = [number, number, number, number];

/** Fresh, warmed-up state for a seed. */
export function seedRngState(seed: number): RngState {
  const state: RngState = [0x9e3779b9, 0x243f6a88, 0xb7e15162, seed >>> 0];
  // Warm up so nearby seeds diverge immediately.
  const rng = rngFromState(state);
  for (let i = 0; i < 15; i++) rng.next();
  return state;
}

/** An Rng that reads and advances `state` in place. */
export function rngFromState(state: RngState): Rng {
  const next = (): number => {
    const a = state[0] >>> 0;
    const b = state[1] >>> 0;
    const c = state[2] >>> 0;
    const d = state[3] >>> 0;
    const t = (((a + b) | 0) + d) | 0;
    state[3] = (d + 1) | 0;
    state[0] = b ^ (b >>> 9);
    state[1] = (c + (c << 3)) | 0;
    state[2] = (((c << 21) | (c >>> 11)) + t) | 0;
    return (t >>> 0) / 4294967296;
  };

  return {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (n) => Math.floor(next() * n),
    fork: () => createRng(Math.floor(next() * 4294967296)),
  };
}

export function createRng(seed: number): Rng {
  return rngFromState(seedRngState(seed));
}
