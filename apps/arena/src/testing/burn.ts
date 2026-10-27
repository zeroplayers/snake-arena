/** How a test bot asks the test sandbox (`worker.ts`) to burn CPU: through its tick's log. */

/** A bot tick that logs this line never returns: the host spins inside the bot's call. */
export const BURN_LINE = "test:burn";
/** A bot tick that logs `test:spin <ms>` keeps the host busy for about that long first. */
export const SPIN_PREFIX = "test:spin ";
