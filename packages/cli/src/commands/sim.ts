import { existsSync, statSync } from "node:fs";
import { basename, extname, relative, resolve } from "node:path";
import { createWorld } from "@zerosnake/engine";
import { houseBots } from "@zerosnake/house-bots";
import { createSandbox } from "@zerosnake/sandbox";
import { bundleBot } from "../bundle.ts";
import { EXIT, UsageError } from "../errors.ts";
import { HOUSE_BOTS, houseBotBundle, isHouseBot } from "../house.ts";
import { type Io, intOption, parse } from "../io.ts";
import { assertLoads } from "../preflight.ts";
import { findEntry, findProject } from "../project.ts";
import { type Contestant, defaultTitle, matchInfo, runMatch } from "../sim/match.ts";
import { DEFAULT_PORT, openBrowser, startSimServer } from "../sim/server.ts";
import { formatSummary } from "../sim/summary.ts";
import { bold, cyan, dim, red, stderrHasColor } from "../term.ts";

export const DEFAULT_TICKS = 3000;
export const DEFAULT_VS = ["easy", "medium", "hard", "chaos"];

export const SIM_HELP = `Usage: zerosnake sim [options]

Runs a local match: your bot in the QuickJS sandbox (the same op budget, memory limit and
strike rules as the arena) against house bots or other local bots, and opens the viewer.

Options:
  --vs <bots>      Opponents, comma-separated: house bots (${HOUSE_BOTS.join(", ")}) or paths
                   to other bots (a file, or a project folder). Repeat a name for two of it.
                   Default: ${DEFAULT_VS.join(",")}
  --seed <n>       World seed (default: random; printed so you can replay a match)
  --ticks <n>      Ticks to simulate, 10 per second of game time (default: ${DEFAULT_TICKS})
  --bot <file>     Your bot's entry file (default: src/bot.ts)
  --headless       Print a summary instead of opening the viewer. Exits with 1 if the
                   sandbox killed your bot (too slow, crashing, out of memory)
  --native-house   Run house bots in Node instead of the sandbox: ~4× faster, but not
                   bit-identical to the arena
  --port <n>       Viewer port (default: ${DEFAULT_PORT}, or the next free one)
  --no-open        Serve the viewer without opening a browser
  -h, --help       Show this help

Examples:
  zerosnake sim
  zerosnake sim --vs hard,hard --seed 7
  zerosnake sim --vs easy,../old-version/src/bot.ts --headless`;

const OPTIONS = {
  vs: { type: "string" },
  seed: { type: "string" },
  ticks: { type: "string" },
  bot: { type: "string" },
  headless: { type: "boolean" },
  "native-house": { type: "boolean" },
  port: { type: "string" },
  open: { type: "boolean", default: true },
  help: { type: "boolean", short: "h" },
} as const;

/** Resolves once the person stops the viewer server (Ctrl+C); tests pass their own. */
export type WaitForStop = () => Promise<void>;

export async function simCommand(
  argv: string[],
  io: Io,
  waitForStop: WaitForStop = waitForSigint,
): Promise<number> {
  const { values, positionals } = parse(argv, OPTIONS, "sim");
  if (values.help) {
    io.out(SIM_HELP);
    return EXIT.ok;
  }
  if (positionals.length > 0) {
    throw new UsageError(
      `Unexpected argument "${positionals[0]}". Use --bot <file> to pick your bot.`,
    );
  }
  const ticks = intOption(values.ticks, "ticks", 1) ?? DEFAULT_TICKS;
  const seed = intOption(values.seed, "seed") ?? Math.floor(Math.random() * 1_000_000);
  const port = intOption(values.port, "port");
  const color = stderrHasColor();

  const project = findProject(io.cwd);
  const entry = findEntry(project, io.cwd, values.bot);
  const you = await bundleBot(entry, { cwd: project.root, color });
  const lineup: Contestant[] = [{ name: project.name, bundle: you.code, you: true }];
  for (const spec of (values.vs ?? DEFAULT_VS.join(",")).split(",")) {
    const item = spec.trim();
    if (item) lineup.push(await opponent(item, io.cwd, color, values["native-house"] === true));
  }
  uniqueNames(lineup);

  const sandbox = await createSandbox();
  for (const c of lineup) if ("bundle" in c) assertLoads(sandbox, c.name, c.bundle, seed);

  const opponents = lineup.slice(1).map((c) => c.name);
  const facts = ` · seed ${seed} · ${ticks} ticks · bundle ${(you.bytes / 1024).toFixed(1)} KB`;
  io.out(`${bold(project.name)} vs ${opponents.join(", ") || "nobody"}${dim(facts)}`);

  if (values.headless) {
    let done = 0;
    const result = await runMatch({
      contestants: lineup,
      seed,
      ticks,
      sandbox,
      onChunk: (chunk) => {
        done += chunk.calls.length;
        io.progress?.(dim(`simulating… ${done}/${ticks}`));
      },
    });
    io.progress?.("");
    io.out(`\n${formatSummary(result)}`);
    const again = [`--seed ${seed}`];
    if (values.vs) again.push(`--vs ${values.vs}`);
    if (values.ticks) again.push(`--ticks ${ticks}`);
    if (values.bot) again.push(`--bot ${values.bot}`);
    if (values["native-house"]) again.push("--native-house");
    io.out(dim(`\nWatch this match: zerosnake sim ${again.join(" ")}`));
    // A bot the sandbox kills would be killed in the arena too: fail scripts and CI.
    const killed = result.lives.filter((l) => l.you && l.death?.sandbox).length;
    if (killed > 0) {
      const lives = killed === 1 ? "1 life" : `${killed} lives`;
      io.err(`\n${red("✗")} The sandbox killed your bot (${lives}); see above.`);
      return EXIT.failure;
    }
    return EXIT.ok;
  }

  const title = defaultTitle(seed);
  const server = await startSimServer({
    info: matchInfo(createWorld({ seed }), title),
    bots: lineup.map((c) => c.name),
    ...(port !== undefined && { port }),
  });
  io.out(`Viewer: ${cyan(server.url)}  ${dim("(Ctrl+C to stop)")}`);
  if (values.open) openBrowser(server.url);

  // Ctrl+C stops the match too, not just the server.
  const stopped = new AbortController();
  const stop = waitForStop().then(() => stopped.abort());
  try {
    const result = await runMatch({
      contestants: lineup,
      seed,
      ticks,
      sandbox,
      title,
      yieldBetweenChunks: true,
      signal: stopped.signal,
      onChunk: (chunk, lives) => server.publish(chunk, lives),
    });
    server.finish(result.lives);
    if (!stopped.signal.aborted) {
      io.out(`\n${formatSummary(result)}`);
      io.out(dim("\nThe match is over; the viewer keeps it until you press Ctrl+C."));
    }
    await stop;
  } finally {
    await server.close();
  }
  return EXIT.ok;
}

/** An opponent from `--vs`: a house bot name, or a path to another bot. */
async function opponent(
  spec: string,
  cwd: string,
  color: boolean,
  nativeHouse: boolean,
): Promise<Contestant> {
  if (isHouseBot(spec)) {
    return nativeHouse
      ? { name: spec, bot: houseBots[spec] }
      : { name: spec, bundle: await houseBotBundle(spec) };
  }
  const path = resolve(cwd, spec);
  if (!existsSync(path)) {
    throw new UsageError(
      `--vs: "${spec}" is neither a house bot (${HOUSE_BOTS.join(", ")}) nor an existing file or folder.`,
    );
  }
  if (statSync(path).isDirectory()) {
    const project = findProject(path);
    const entry = findEntry(project, cwd);
    const bundle = await bundleBot(entry, { cwd: project.root, color });
    return { name: project.name, bundle: bundle.code };
  }
  const bundle = await bundleBot(path, { cwd, color });
  const name = basename(path, extname(path));
  // `src/bot.ts` of another project says little; name it after its folder.
  const shown = name === "bot" || name === "index" ? `${findProject(path).name}` : name;
  return { name: shown || relative(cwd, path), bundle: bundle.code };
}

/** `hard,hard` → `hard`, `hard-2`. */
function uniqueNames(lineup: Contestant[]): void {
  const seen = new Map<string, number>();
  for (const c of lineup) {
    const n = (seen.get(c.name) ?? 0) + 1;
    seen.set(c.name, n);
    if (n > 1) c.name = `${c.name}-${n}`;
  }
}

function waitForSigint(): Promise<void> {
  return new Promise((resolve) => process.once("SIGINT", () => resolve()));
}
