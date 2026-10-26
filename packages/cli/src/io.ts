import { type ParseArgsConfig, parseArgs } from "node:util";
import { UsageError } from "./errors.ts";

/** Where a command prints. The binary uses stdout/stderr; tests collect the text. */
export interface Io {
  out(text: string): void;
  err(text: string): void;
  /** Working directory of the command. */
  cwd: string;
  /** Live progress on the terminal (overwritten in place); a no-op when not a TTY. */
  progress?(text: string): void;
}

export function processIo(): Io {
  const tty = process.stderr.isTTY === true;
  return {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    cwd: process.cwd(),
    ...(tty && {
      progress: (text: string) => process.stderr.write(`\r\x1b[2K${text}`),
    }),
  };
}

type Options = NonNullable<ParseArgsConfig["options"]>;

/** `util.parseArgs` with usage errors a person can read, and `--help` handled by the caller. */
export function parse<O extends Options>(argv: string[], options: O, command: string) {
  try {
    return parseArgs({
      args: argv,
      options,
      allowPositionals: true,
      allowNegative: true,
      strict: true,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new UsageError(`${message}\nRun \`zerosnake ${command} --help\` for the options.`);
  }
}

/** A non-negative integer option, or a usage error naming it. */
export function intOption(value: string | undefined, name: string, min = 0): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min) {
    throw new UsageError(
      `--${name} must be a whole number${min > 0 ? ` ≥ ${min}` : ""}, got "${value}"`,
    );
  }
  return n;
}
