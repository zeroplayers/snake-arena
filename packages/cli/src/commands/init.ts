import { relative } from "node:path";
import { EXIT, UsageError } from "../errors.ts";
import { initProject } from "../init.ts";
import { type Io, parse } from "../io.ts";
import { bold, cyan, dim, green } from "../term.ts";

export const INIT_HELP = `Usage: zerosnake init <dir>

Creates a bot project in <dir> (a new or empty folder) from the bot template: src/bot.ts, the
SDK, CLAUDE.md and tests. Works offline.

Options:
  -h, --help   Show this help

Example:
  zerosnake init my-snake`;

const OPTIONS = { help: { type: "boolean", short: "h" } } as const;

export function initCommand(argv: string[], io: Io): number {
  const { values, positionals } = parse(argv, OPTIONS, "init");
  if (values.help) {
    io.out(INIT_HELP);
    return EXIT.ok;
  }
  const [target, extra] = positionals;
  if (!target)
    throw new UsageError("Which folder? Usage: zerosnake init <dir>, e.g. zerosnake init my-snake");
  if (extra) throw new UsageError(`Unexpected argument "${extra}". Usage: zerosnake init <dir>`);

  const result = initProject(target, { cwd: io.cwd });
  const shown = relative(io.cwd, result.dir) || ".";
  io.out(`${green("✓")} Created ${bold(result.name)} in ${shown} (${result.files.length} files)`);
  if (result.omitted.length > 0) {
    io.out(
      dim(
        `Not on npm yet, so left out of package.json: ${result.omitted.join(", ")}.\n` +
          "The template's own tests need them; `npx zerosnake sim` and `test` don't.",
      ),
    );
  }
  io.out("");
  io.out("Next:");
  if (shown !== ".") io.out(cyan(`  cd ${shown}`));
  io.out(`${cyan("  npx zerosnake sim")}     watch your bot play house bots`);
  io.out(`${cyan("  claude")}                and ask it to make the snake smarter`);
  return EXIT.ok;
}
