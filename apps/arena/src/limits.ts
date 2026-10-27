/**
 * Room limits and batch sizing (SPEC §5, spike #2 `spikes/quickjs-do/RESULTS.md`).
 *
 * The clock inside a Worker is frozen during CPU work, so a room can't time its own batches.
 * Instead every batch is sized for the worst case: every bot spending its whole per-tick budget
 * on every tick. That has to fit the DO CPU limit with headroom; what still doesn't (operators on
 * huge strings, which the sandbox can't charge) is the backstop's job.
 */
import { DEFAULT_OP_BUDGET } from "@zerosnake/sandbox";

/**
 * CPU limit of one invocation of this Worker, Durable Objects included: `limits.cpu_ms` in
 * `wrangler.jsonc` (5 minutes, the plan maximum, which the checks consumer needs). Cloudflare has
 * no per-class limit, so rooms get it too. `limits.test.ts` checks that it matches every
 * environment of the config.
 *
 * This is when Cloudflare kills an invocation, so it is what the backstop's evidence is measured
 * against: a batch that died younger than 0.9 × this was a restart.
 */
export const DO_CPU_LIMIT_MS = 300_000;

/**
 * The room's own CPU budget for an invocation, well under the hard limit: batches are sized for
 * their worst case to fit `BATCH_CPU_SHARE` of it, and watch mode stops batches at shares of it.
 * 30 s is what rooms were sized and measured for (Cloudflare's default limit, spike #2).
 *
 * So an honest invocation (worst case 15 s of CPU; a watched one at most this much wall time)
 * never gets near the hard limit, and a kill is only ever a bot the meter can't stop, which the
 * hard limit then has to: such a kill costs the full 300 s. The room can't stop a call sooner (the
 * clock is frozen during CPU work, and what the meter can't charge never reaches its interrupt
 * handler), so a burner costs up to (1 + `KILLS_TO_EVICT`) × 300 s per life, two lives before its
 * version is quarantined. Making that seconds needs rooms in a Worker of their own with a lower
 * `limits.cpu_ms`, which is a deploy change (a second script and a transferred DO class).
 */
export const ROOM_CPU_BUDGET_MS = 30_000;
/** Share of the room's CPU budget a worst-case batch may use. */
export const BATCH_CPU_SHARE = 0.5;

/**
 * Cloudflare CPU of one op of budget, worst case. An op is one interrupt-handler call (spike:
 * 0.6–0.9 ms each for heavy code on Cloudflare) plus up to `WORK_PER_OP` units of native work
 * (≈ 1 ms on an M1, ≈ 1.7 ms on Cloudflare, which ran 1.6–1.8× slower than Node in the spike).
 * A bot can exhaust both counters in the same tick, so they add up.
 */
export const WORST_MS_PER_OP = 0.9 + 1.7;
/** Per bot-tick cost outside the bot's budget: building and copying its state (~28 KB worst). */
export const STATE_MS = 1;
/** Worst CPU of one bot tick. */
export const WORST_BOT_TICK_MS = DEFAULT_OP_BUDGET * WORST_MS_PER_OP + STATE_MS;
/** Op budget of module evaluation plus `init()` (the sandbox's `initOpBudget` default). */
export const INIT_OP_BUDGET = 100;
/** Largest bundle a version can have (the checks' `LIMITS.maxBundleBytes`, test-enforced). */
export const MAX_BUNDLE_BYTES = 256 * 1024;
/**
 * Instrumenting a bundle of `MAX_BUNDLE_BYTES` for the meter, which `startLife` does before the
 * life starts: up to ~160 ms on an M1 (the worst shapes measured: many small functions; ~0.6 s per
 * MB), × 1.8 on Cloudflare. A room's sandbox caches it only while the room stays loaded, and every
 * rerun after a kill or an abandoned tick starts all its bots again in a fresh one.
 */
export const WORST_INSTRUMENT_MS = 300;
/**
 * Worst CPU of starting a life: instrumenting its bundle, the prelude (~3.7 ms on an M1) and the
 * init budget.
 */
export const WORST_LIFE_START_MS = WORST_INSTRUMENT_MS + 7 + INIT_OP_BUDGET * WORST_MS_PER_OP;
/** Engine step for a full room, generous. */
export const ENGINE_TICK_MS = 2;
/** Loading and persisting the room around a batch (world JSON, replay chunk, roster). */
export const BATCH_OVERHEAD_MS = 1_000;

/** Upper bound on a batch even when the room is nearly empty. */
export const MAX_BATCH_TICKS = 500;
/** Real-time mode runs this many ticks per alarm (one second at 10 tps). */
export const REALTIME_BATCH_TICKS = 10;

export const DEFAULT_MAX_SNAKES = 20;
export const DEFAULT_MIN_AUTHORS = 5;

/** Stop simulating while the outbox holds more undelivered items than this. */
export const DEFAULT_MAX_OUTBOX = 500;

/** After the matchmaker had nothing for us, ask again at most this often (unless a life ends). */
export const NEXT_LIFE_RETRY_MS = 10_000;
/**
 * The alarm set before a batch starts, so a batch that dies is picked up again. Cloudflare also
 * retries a failed alarm, but only a few times.
 */
export const SAFETY_ALARM_MS = 1_000;

/**
 * Ticks for the next batch: the most whose worst case (every bot at its full budget every tick,
 * plus starting `lifeStarts` lives) stays within `BATCH_CPU_SHARE` of the room's CPU budget.
 *
 * The sandbox's meter bounds a tick's cost (with #62, also straight-line code, #60), except for
 * what it can't charge (operators on huge strings), which can still run far over this worst case.
 * The backstop (`room/backstop.ts`) covers that by evicting the bot.
 */
export function batchTicks(
  bots: number,
  lifeStarts: number,
  cpuBudgetMs = ROOM_CPU_BUDGET_MS,
): number {
  const budget =
    cpuBudgetMs * BATCH_CPU_SHARE - BATCH_OVERHEAD_MS - lifeStarts * WORST_LIFE_START_MS;
  const perTick = bots * WORST_BOT_TICK_MS + ENGINE_TICK_MS;
  return Math.max(1, Math.min(MAX_BATCH_TICKS, Math.floor(budget / perTick)));
}
