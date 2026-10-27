import { deployCommand } from "./commands/deploy.ts";
import { initCommand } from "./commands/init.ts";
import { loginCommand, logoutCommand } from "./commands/login.ts";
import { logsCommand } from "./commands/logs.ts";
import { simCommand } from "./commands/sim.ts";
import { statusCommand } from "./commands/status.ts";
import { testCommand } from "./commands/test.ts";
import { CliError, EXIT } from "./errors.ts";
import { type Io, processIo } from "./io.ts";
import { packageRoot, readJson } from "./paths.ts";
import { defaultRemote, type Remote } from "./remote/api.ts";
import { DEFAULT_URL } from "./remote/config.ts";
import { red } from "./term.ts";

export const HELP = `Usage: zerosnake <command> [options]

Commands:
  init <dir>   Create a bot project in <dir>
  sim          Run a local match in the sandbox and watch it in the browser
  test         Run the checks the server runs on deploy
  login        Sign the CLI in to the arena (opens the browser)
  logout       Revoke the CLI's token and delete it here
  deploy       Upload your bot; it plays in the arena once it passes the checks
  status       Your bots: active version, rating, lives, deploys left today
  logs         A version's check report and recent lives

Replays and death traces of arena lives are on your bot's page on the site.

Run \`zerosnake <command> --help\` for a command's options.
Docs: ${DEFAULT_URL}/docs`;

const LATER = new Set(["replays"]);

/**
 * Runs the CLI and returns its exit code (see `EXIT`). Never throws. `remote` is what the
 * commands that talk to the server use (network, environment, clock); tests replace it.
 */
export async function main(
  argv: string[],
  io: Io = processIo(),
  remote: Remote = defaultRemote(),
): Promise<number> {
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
      case "login":
        return await loginCommand(rest, io, remote);
      case "logout":
        return await logoutCommand(rest, io, remote);
      case "deploy":
        return await deployCommand(rest, io, remote);
      case "status":
        return await statusCommand(rest, io, remote);
      case "logs":
        return await logsCommand(rest, io, remote);
      default:
        if (LATER.has(command)) {
          io.err(`\`zerosnake ${command}\` isn't available yet: watch replays on your bot's page.`);
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
