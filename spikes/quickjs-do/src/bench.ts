import { createRng } from "@zerosnake/engine";
import type {
  QuickJSContext,
  QuickJSHandle,
  QuickJSRuntime,
  QuickJSWASMModule,
} from "quickjs-emscripten-core";
import {
  BOTS,
  type BotKind,
  DEEP_RECURSION_BOT,
  INFINITE_LOOP_BOT,
  MEMORY_BOMB_BOT,
} from "./bots.ts";

/**
 * Platform-agnostic benchmark. Runs in Node and in a Durable Object. Inside Workers the
 * clock only advances on I/O, so `now()` may return the same value throughout; there the
 * caller measures wall/CPU time from outside and the interrupt counts are the signal.
 */

export interface BenchOptions {
  bots: number;
  ticks: number;
  kind: BotKind;
  /** Interrupt handler calls allowed per tick before the bot is stopped. */
  budget?: number;
  memoryLimitBytes?: number;
}

export interface BenchResult {
  bots: number;
  ticks: number;
  kind: BotKind;
  stateBytes: number;
  setupMs: number;
  runMs: number;
  usPerBotTick: number;
  interruptsPerBotTick: { avg: number; max: number };
  memoryBytesPerContext: number;
  errors: number;
}

interface Bot {
  runtime: QuickJSRuntime;
  ctx: QuickJSContext;
  fn: QuickJSHandle;
  interrupts: number;
}

const DEFAULT_BUDGET = 1000;
const DEFAULT_MEMORY = 8 * 1024 * 1024;

/** A pool of realistic in-view states: 60 food, 8 snakes × 25 segments. */
export function makeStates(count: number, seed = 1): string[] {
  const rng = createRng(seed);
  return Array.from({ length: count }, (_, t) => {
    const point = () => ({ x: rng.range(-100, 100), y: rng.range(-100, 100) });
    return JSON.stringify({
      tick: t,
      self: { x: 0, y: 0, angle: rng.range(-Math.PI, Math.PI), length: 40, speed: 2 },
      food: Array.from({ length: 60 }, point),
      snakes: Array.from({ length: 8 }, (_, i) => ({
        id: `s${i}`,
        length: 25,
        segments: Array.from({ length: 25 }, point),
      })),
    });
  });
}

function createBot(qjs: QuickJSWASMModule, source: string, budget: number, memory: number): Bot {
  const runtime = qjs.newRuntime();
  runtime.setMemoryLimit(memory);
  runtime.setMaxStackSize(256 * 1024);
  const bot = { runtime, interrupts: 0 } as Bot;
  runtime.setInterruptHandler(() => ++bot.interrupts > budget);
  bot.ctx = runtime.newContext();
  bot.ctx.unwrapResult(bot.ctx.evalCode(source)).dispose();
  bot.fn = bot.ctx.getProp(bot.ctx.global, "__tick");
  return bot;
}

function disposeBot(bot: Bot) {
  bot.fn.dispose();
  bot.ctx.dispose();
  bot.runtime.dispose();
}

/** One tick for one bot. Returns the action JSON or an error message. */
function tickBot(
  bot: Bot,
  state: string,
): { ok: true; out: string } | { ok: false; error: string } {
  bot.interrupts = 0;
  const arg = bot.ctx.newString(state);
  const res = bot.ctx.callFunction(bot.fn, bot.ctx.undefined, arg);
  arg.dispose();
  if (res.error) {
    const err = bot.ctx.dump(res.error);
    res.error.dispose();
    return {
      ok: false,
      error: typeof err === "object" ? `${err.name}: ${err.message}` : String(err),
    };
  }
  const out = bot.ctx.getString(res.value);
  res.value.dispose();
  return { ok: true, out };
}

function mallocBytes(bot: Bot): number {
  const h = bot.runtime.computeMemoryUsage();
  const usage = bot.ctx.dump(h) as { memory_used_size?: number };
  h.dispose();
  return usage.memory_used_size ?? 0;
}

export function runBench(
  qjs: QuickJSWASMModule,
  opts: BenchOptions,
  now: () => number,
): BenchResult {
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const memory = opts.memoryLimitBytes ?? DEFAULT_MEMORY;
  const states = makeStates(32);

  const t0 = now();
  const bots = Array.from({ length: opts.bots }, () =>
    createBot(qjs, BOTS[opts.kind], budget, memory),
  );
  const t1 = now();

  let errors = 0;
  let interruptSum = 0;
  let interruptMax = 0;
  for (let t = 0; t < opts.ticks; t++) {
    const state = states[t % states.length] as string;
    for (const bot of bots) {
      if (!tickBot(bot, state).ok) errors++;
      interruptSum += bot.interrupts;
      if (bot.interrupts > interruptMax) interruptMax = bot.interrupts;
    }
  }
  const t2 = now();

  const malloc = bots.length ? bots.reduce((s, b) => s + mallocBytes(b), 0) / bots.length : 0;
  for (const bot of bots) disposeBot(bot);

  const botTicks = opts.bots * opts.ticks || 1;
  return {
    bots: opts.bots,
    ticks: opts.ticks,
    kind: opts.kind,
    stateBytes: (states[0] as string).length,
    setupMs: t1 - t0,
    runMs: t2 - t1,
    usPerBotTick: ((t2 - t1) * 1000) / botTicks,
    interruptsPerBotTick: { avg: interruptSum / botTicks, max: interruptMax },
    memoryBytesPerContext: Math.round(malloc),
    errors,
  };
}

export interface SafetyResult {
  name: string;
  error: string | null;
  interrupts: number;
  ms: number;
  /** After the failure, can the same runtime still run a normal tick? */
  recovers: boolean;
}

/** Hostile bots: each must fail fast with a clear error and leave the host healthy. */
export function runSafety(
  qjs: QuickJSWASMModule,
  now: () => number,
  budget = DEFAULT_BUDGET,
): SafetyResult[] {
  const state = makeStates(1)[0] as string;
  const cases = [
    ["infinite-loop", INFINITE_LOOP_BOT],
    ["memory-bomb", MEMORY_BOMB_BOT],
    ["deep-recursion", DEEP_RECURSION_BOT],
  ] as const;
  return cases.map(([name, source]) => {
    const bot = createBot(qjs, source, budget, DEFAULT_MEMORY);
    const t0 = now();
    const res = tickBot(bot, state);
    const ms = now() - t0;
    const interrupts = bot.interrupts;
    // Swap in a well-behaved function to see whether the runtime survived.
    let recovers = false;
    try {
      bot.ctx.unwrapResult(bot.ctx.evalCode(BOTS.typical)).dispose();
      bot.fn.dispose();
      bot.fn = bot.ctx.getProp(bot.ctx.global, "__tick");
      recovers = tickBot(bot, state).ok;
    } catch {
      recovers = false;
    }
    const result = { name, error: res.ok ? null : res.error, interrupts, ms, recovers };
    try {
      disposeBot(bot);
    } catch {
      // A runtime that hit its memory limit may refuse to free cleanly; that's part of the finding.
    }
    return result;
  });
}
