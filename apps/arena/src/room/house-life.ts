/**
 * House bots run natively in the room, not in the QuickJS sandbox (#108). They are our own code
 * (`@zerosnake/house-bots`), trusted, cheap (~0.02 ms a tick each in a full room on an M1, against
 * ~0.8 ms in the sandbox) and deterministic: their only randomness comes from `info.seed` (the
 * snake's, saved with the world). So, like a sandboxed life, a house life restarts after a reload
 * with `init` at the saved frame and plays the same from there, and a rerun of a batch plays as
 * the first run would have.
 *
 * Nothing of the sandbox's budget applies: no ops or memory metering, no strikes, no `timeout`
 * death, and the backstop's watch hooks skip their calls (`RoomSim`), so a kill never names one.
 * A house bot that throws keeps its last action and lives on (it never dies by `error`), so the
 * only `error` fault a house snake gets is the room's own: retired to make way for a real life,
 * or by the arena's stop switch. Viewers show that as `retired` (the viewer's
 * `presentedCause`).
 */
import { type HouseBotName, houseBots } from "@zerosnake/house-bots";
import type { TickReport } from "@zerosnake/sandbox";
import { type BotAction, type BotInfo, type BotState, createTickLog } from "@zerosnake/sdk";

/** What `RoomSim` drives: a sandbox `BotLife` or a native house life. */
export interface SimLife {
  tick(state: BotState): TickReport;
  dispose(): void;
}

/** Whether `kind` is a house bot this worker ships. */
export function isHouseKind(kind: string): kind is HouseBotName {
  return Object.hasOwn(houseBots, kind);
}

/** Starts a house bot's life natively: its `init` now, then one `tick` per call. */
export function startHouseLife(kind: string, info: BotInfo): SimLife {
  if (!isHouseKind(kind)) throw new Error(`no house bot ${kind}`);
  const bot = houseBots[kind];
  // House bots don't log anywhere (they aren't traced): a zero-byte log drops every line.
  const { log } = createTickLog(0);
  let mem: object = {};
  try {
    mem = bot.init?.(info) ?? {};
  } catch (e) {
    console.error("house bot init threw", kind, e);
  }
  let last: BotAction = { turn: 0 };
  let errors = 0;
  return {
    tick(state) {
      let error: string | null = null;
      try {
        const action = bot.tick(state, mem, log);
        last = { turn: action.turn, boost: action.boost === true };
        errors = 0;
      } catch (e) {
        errors++;
        error = String(e);
        if (errors === 1) console.error("house bot tick threw", kind, e);
      }
      return {
        action: last,
        outcome: error === null ? "ok" : "error",
        error,
        interrupts: 0,
        work: 0,
        log: { lines: [], truncated: false },
        strikes: 0,
        errors,
        death: null,
      };
    },
    dispose() {},
  };
}
