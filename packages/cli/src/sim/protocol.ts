import type { LifeDeath, LifeInfo, MatchInfo } from "@zerosnake/viewer";

/**
 * What `zerosnake sim` sends from the match running in Node to the viewer page. The world itself
 * travels as engine replay chunks (`ReplayRecorder`), which the page re-simulates; alongside go
 * what a replay can't hold: each bot call's ops and `log()` lines, and the lives with the
 * sandbox's reason for each death. No Node imports here: the page bundles this file.
 */

/** One bot call: what a snake's bot did after seeing a tick. Short keys: there are many. */
export interface SnakeCall {
  /** Interrupt-handler calls (the sandbox's op count); absent for bots run outside it. */
  o?: number;
  /** `turn` as returned (what the engine got, before quantising). */
  a: number;
  /** Boost asked for. */
  b?: 1;
  /** `log()` lines, plus `⚠` lines the CLI adds for strikes, errors and the sandbox's verdict. */
  l?: string[];
  /** The log hit the per-tick byte limit. */
  t?: 1;
}

/** Bot calls of one tick by life id. */
export type TickCalls = Record<string, SnakeCall>;

export interface SandboxVerdict {
  reason: "timeouts" | "errors" | "oom" | "load" | "crash";
  message: string;
}

export interface SimDeath extends LifeDeath {
  /** Set when the sandbox killed the snake (cause `timeout` or `error`). */
  readonly sandbox?: SandboxVerdict;
}

/** A life as the match knows it; the page adds the colour. */
export interface SimLife extends Omit<LifeInfo, "color" | "death"> {
  /** Driven by the bot under development (not an opponent). */
  readonly you: boolean;
  readonly death?: SimDeath;
}

/** One replay chunk and the calls of each of its ticks (`calls[k]` is tick `start + k`). */
export interface SimChunk {
  bytes: Uint8Array;
  calls: TickCalls[];
}

/** `GET /api/match?from=N`: everything after the first N chunks. */
export interface MatchUpdate {
  info: MatchInfo;
  /** Bot names in lineup order (the page colours lives by it). */
  bots: string[];
  /** Index of the first chunk in `chunks`. */
  from: number;
  chunks: { data: string; calls: TickCalls[] }[];
  /** Every life so far. */
  lives: SimLife[];
  /** The match is over: no more chunks will come. */
  done: boolean;
  /** Set when the match stopped on an error. */
  error?: string;
}
