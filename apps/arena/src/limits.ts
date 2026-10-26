/**
 * Room limits and batch sizing (SPEC §5, spike #2 `spikes/quickjs-do/RESULTS.md`).
 *
 * The clock inside a Worker is frozen during CPU work, so a room can't time its own batches.
 * Instead every batch is sized for the worst case: every bot spending its whole per-tick budget
 * on every tick. That has to fit the DO CPU limit with headroom; what still doesn't (operators on
 * huge strings, which the sandbox can't charge) is the backstop's job.
 */
import { DEFAULT_OP_BUDGET } from "@zerosnake/sandbox";

/** CPU limit of one Durable Object invocation (Workers Paid default; `limits.cpu_ms` raises it). */
export const DO_CPU_LIMIT_MS = 30_000;
/** Share of the CPU limit a worst-case batch may use. */
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
/** Worst CPU of starting a life: the prelude (~3.7 ms on an M1) plus the init budget. */
export const WORST_LIFE_START_MS = 7 + INIT_OP_BUDGET * WORST_MS_PER_OP;
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
 * plus starting `lifeStarts` lives) stays within `BATCH_CPU_SHARE` of the DO CPU limit.
 *
 * The sandbox's op budget doesn't yet bound straight-line code inside one op (#60), so a bot can
 * still run far over this worst case; the backstop (`room/backstop.ts`) covers that.
 */
export function batchTicks(bots: number, lifeStarts: number, cpuLimitMs = DO_CPU_LIMIT_MS): number {
  const budget =
    cpuLimitMs * BATCH_CPU_SHARE - BATCH_OVERHEAD_MS - lifeStarts * WORST_LIFE_START_MS;
  const perTick = bots * WORST_BOT_TICK_MS + ENGINE_TICK_MS;
  return Math.max(1, Math.min(MAX_BATCH_TICKS, Math.floor(budget / perTick)));
}
