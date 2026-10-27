import { initCommand } from "./commands/init.ts";
import { simCommand } from "./commands/sim.ts";
import { testCommand } from "./commands/test.ts";
import { CliError, EXIT } from "./errors.ts";
import { type Io, processIo } from "./io.ts";
import { packageRoot, readJson } from "./paths.ts";
import { red } from "./term.ts";

export const HELP = `Usage: zerosnake <command> [options]

Commands:
  init <dir>   Create a bot project in <dir>
  sim          Run a local match in the sandbox and watch it in the browser
  test         Run the checks the server runs on deploy

Coming soon: login, deploy, status, logs.

Run \`zerosnake <command> --help\` for a command's options.
Docs: https://github.com/zeroplayers/snake-arena`;

const LATER = new Set(["login", "logout", "deploy", "status", "logs", "replays"]);

/** Runs the CLI and returns its exit code (see `EXIT`). Never throws. */
export async function main(argv: string[], io: Io = processIo()): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
      case "help":
      case "-h":
      case "--help":
        io.out(HELP);
        return command === undefined ? EXIT.usage : EXIT.ok;
      case "-v":
      case "--version":
        io.out(String(readJson(`${packageRoot()}/package.json`).version));
        return EXIT.ok;
      case "init":
        return initCommand(rest, io);
      case "sim":
        return await simCommand(rest, io);
      case "test":
        return await testCommand(rest, io);
      default:
        if (LATER.has(command)) {
          io.err(`\`zerosnake ${command}\` isn't available yet (zeroplayers/snake-arena#21).`);
          return EXIT.failure;
        }
        io.err(`Unknown command "${command}".\n\n${HELP}`);
        return EXIT.usage;
    }
  } catch (e) {
    if (e instanceof CliError) {
      io.err(`${red("✗")} ${e.message}`);
      return e.exitCode;
    }
    io.err(
      `${red("✗")} zerosnake crashed; please report this:\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    );
    return EXIT.failure;
  }
}
