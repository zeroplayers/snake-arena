import { readSources, runLocalChecks } from "../artifact.ts";
import { bundleBot } from "../bundle.ts";
import { EXIT, UsageError } from "../errors.ts";
import { type Io, parse } from "../io.ts";
import { findEntry, findProject } from "../project.ts";
import { dim, green, stderrHasColor } from "../term.ts";

export const TEST_HELP = `Usage: zerosnake test [options]

Runs the checks the server runs on every deploy: size limits, loading in the sandbox, matches
on fixed seeds against house bots (no exceptions, no timeouts), and qualification (beat easy).

Options:
  --bot <file>   Your bot's entry file (default: src/bot.ts)
  -h, --help     Show this help`;

const OPTIONS = {
  bot: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

/** zeroplayers/snake-arena#13 builds the shared check suite this command will run. */
export const CHECKS_PENDING =
  "The full check suite is coming with zeroplayers/snake-arena#13 (@zerosnake/checks).\n" +
  "Until then `zerosnake test` only checks the deploy limits and loads your bot in the sandbox;\n" +
  "use `zerosnake sim --headless` to see how it plays.";

export async function testCommand(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(argv, OPTIONS, "test");
  if (values.help) {
    io.out(TEST_HELP);
    return EXIT.ok;
  }
  if (positionals.length > 0) {
    throw new UsageError(
      `Unexpected argument "${positionals[0]}". Use --bot <file> to pick your bot.`,
    );
  }
  const project = findProject(io.cwd);
  const entry = findEntry(project, io.cwd, values.bot);
  const bundle = await bundleBot(entry, { cwd: project.root, color: stderrHasColor() });
  const sources = readSources(project.root, bundle);
  io.out(
    `${green("✓")} bundles ${dim(`(${(bundle.bytes / 1024).toFixed(1)} KB from ${sources.length} source files)`)}`,
  );
  await runLocalChecks(io, bundle, sources);

  io.err(`\n${CHECKS_PENDING}`);
  return EXIT.failure;
}
