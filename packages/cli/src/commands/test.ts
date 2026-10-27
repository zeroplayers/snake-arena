import { formatReport } from "@zerosnake/checks";
import { readSources, runLocalChecks } from "../artifact.ts";
import { bundleBot } from "../bundle.ts";
import { EXIT, UsageError } from "../errors.ts";
import { type Io, parse } from "../io.ts";
import { findEntry, findProject } from "../project.ts";
import { dim, green, stderrHasColor } from "../term.ts";

export const TEST_HELP = `Usage: zerosnake test [options]

Bundles your bot exactly like \`sim\` and \`deploy\` and runs the checks the server runs on every
deploy: the deploy limits, loading in the sandbox, 5 matches × 1000 ticks against the house bots
(no timeouts, exceptions or running out of memory, and on average at most half the per-tick
budget), and qualification (a mean score per life at least that of the easy house bot in your
seat). Takes a few seconds.

The seeds come from the bundle's hash: the server uses the same ones for the same bundle, so it
reaches the same verdict, but any edit to the bot gives other seeds. A bot close to easy's score
can pass on one version and fail on the next; compare versions with \`sim --headless\` on many
seeds instead.

Options:
  --bot <file>   Your bot's entry file (default: src/bot.ts)
  --json         Print the check report as JSON on stdout (what the server stores with each
                 version); everything else goes to stderr
  -h, --help     Show this help

Exit codes: 0 the bot passes, 1 it fails a check (or doesn't build), 2 bad command line.
A problem found before the matches (a build error, a deploy limit) prints no JSON.`;

const OPTIONS = {
  bot: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

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
  // With --json, stdout carries the report alone.
  const human: Io = values.json ? { ...io, out: io.err } : io;
  const project = findProject(io.cwd);
  const entry = findEntry(project, io.cwd, values.bot);
  const bundle = await bundleBot(entry, { cwd: project.root, color: stderrHasColor() });
  const sources = readSources(project.root, bundle);
  human.out(
    `${green("✓")} bundles ${dim(`(${(bundle.bytes / 1024).toFixed(1)} KB from ${sources.length} source files)`)}`,
  );
  const report = await runLocalChecks(human, bundle, sources);

  if (values.json) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    io.out(`\n${formatReport(report).trimEnd()}`);
    if (report.passed) io.out(`\nReady to deploy: ${dim("npx zerosnake deploy")}`);
  }
  return report.passed ? EXIT.ok : EXIT.failure;
}
