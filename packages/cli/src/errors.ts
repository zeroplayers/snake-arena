/** Exit codes of the `zerosnake` binary. */
export const EXIT = Object.freeze({
  ok: 0,
  /** The bot failed: it didn't build, didn't load, or failed a check. */
  failure: 1,
  /** Bad command line. */
  usage: 2,
});

/**
 * An error meant for the person at the terminal: its message is printed as is (no stack), and
 * the process exits with `exitCode`.
 */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number = EXIT.failure) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super(message, EXIT.usage);
    this.name = "UsageError";
  }
}
