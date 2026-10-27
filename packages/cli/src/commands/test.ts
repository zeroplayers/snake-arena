import { DEFAULT_MAX_MILLIS, formatReport } from "@zerosnake/checks";
import { readSources, runLocalChecks, SLOW_SUITE_MS, slowSuiteWarning } from "../artifact.ts";
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
seat).

Usually takes a few seconds. Here the checks stop a bot at ${DEFAULT_MAX_MILLIS / 1000} s; the server
runs them under a CPU time limit instead, possibly on a slower machine, so a slow bot can pass
here and still be rejected there. \`test\` warns when the checks take ${SLOW_SUITE_MS / 1000} s or more.

The seeds come from the bundle's hash: the server uses the same ones for the same bundle, so it
reaches the same verdict, but any edit to the bot gives other seeds. A bot close to easy's score
can pass on one version and fail on the next: aim for a clear margin, and compare versions with
\`sim --headless\` on many seeds rather than by one \`test\`.

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
  const { report, millis } = await runLocalChecks(human, bundle, sources);
  const slow = report.passed ? slowSuiteWarning(millis) : null;

  if (values.json) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    io.out(`\n${formatReport(report).trimEnd()}`);
    if (report.passed) io.out(`\nReady to deploy: ${dim("npx zerosnake deploy")}`);
  }
  if (slow) human.out(`\n${slow}`);
  return report.passed ? EXIT.ok : EXIT.failure;
}
