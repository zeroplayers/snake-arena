import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  BotInfo,
  DeployMeta,
  DeployRequest,
  DeployResponse,
  MeResponse,
  VersionInfo,
} from "@zerosnake/web/shared";
import { formatReport, readSources, runLocalChecks } from "../artifact.ts";
import { bundleBot } from "../bundle.ts";
import { CliError, EXIT, UsageError } from "../errors.ts";
import { type Io, parse } from "../io.ts";
import { readJson } from "../paths.ts";
import { findEntry, findProject } from "../project.ts";
import {
  type Api,
  ApiError,
  cliVersion,
  defaultRemote,
  explain,
  localTime,
  NetworkError,
  type Remote,
  signedInApi,
  withRetries,
} from "../remote/api.ts";
import { botName, botPage, botSlug, noSuchBot } from "../remote/bots.ts";
import { DEFAULT_URL, serverUrl } from "../remote/config.ts";
import { bold, cyan, dim, green, red, stderrHasColor, yellow } from "../term.ts";

export const DEPLOY_HELP = `Usage: zerosnake deploy [options]

Bundles your bot exactly like \`sim\`, runs the local checks (deploy limits, loading in the
sandbox), uploads the bundle and your sources (public on your bot's page), and waits while the
server checks the new version. A version that passes replaces the bot's active one in the arena.

Options:
  --bot <slug>          Which of your bots to deploy to (default: "zerosnake": { "bot" } in
                        package.json, else the package name)
  --create              Create the bot if you don't have it yet
  --entry <file>        Your bot's entry file (default: src/bot.ts)
  -m, --message <text>  A note for this version, like a commit message
  --no-wait             Don't wait for the server's checks
  --url <url>           Server (default: ${DEFAULT_URL}, or ZEROSNAKE_URL)
  -h, --help            Show this help

Exit codes: 0 deployed (or uploaded, with --no-wait), 1 the bot failed a check or the deploy
failed, 2 bad command line.`;

const OPTIONS = {
  bot: { type: "string" },
  create: { type: "boolean" },
  entry: { type: "string" },
  message: { type: "string", short: "m" },
  wait: { type: "boolean", default: true },
  url: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

/** How often to ask for the version's status while the server checks it. */
export const POLL_MS = 2000;
/** Give up waiting (the checks go on) after this long. */
export const WAIT_MS = 10 * 60_000;

export async function deployCommand(
  argv: string[],
  io: Io,
  remote: Remote = defaultRemote(),
): Promise<number> {
  const { values, positionals } = parse(argv, OPTIONS, "deploy");
  if (values.help) {
    io.out(DEPLOY_HELP);
    return EXIT.ok;
  }
  if (positionals.length > 0) {
    throw new UsageError(
      `Unexpected argument "${positionals[0]}". Use --bot <slug> for the bot, --entry <file> for its file.`,
    );
  }
  if (values.message !== undefined && values.message.length > 200) {
    throw new UsageError("--message is at most 200 characters.");
  }
  const server = serverUrl(values.url, remote.env);
  const api = signedInApi(server, remote);
  const project = findProject(io.cwd);
  const slug = botSlug(project, values.bot);

  // Before any work: who we are, whether the bot exists, the quota and the server's limits.
  const me = await api.call<MeResponse>("GET", "/api/me").catch((e: unknown) => {
    throw explain(e, server);
  });
  const existing = me.bots.find((b) => b.slug === slug);
  if (!existing && !values.create) throw noSuchBot(me, slug, server);
  if (me.quota.deploysToday >= me.quota.deploysPerDay) {
    throw new CliError(
      `You've used all ${me.quota.deploysPerDay} deploys for today. More at ${localTime(me.quota.resetsAt)} (00:00 UTC).`,
    );
  }

  const entry = findEntry(project, io.cwd, values.entry);
  const bundle = await bundleBot(entry, { cwd: project.root, color: stderrHasColor() });
  const sources = readSources(project.root, bundle);
  io.out(
    `${green("✓")} bundles ${dim(`(${(bundle.bytes / 1024).toFixed(1)} KB from ${sources.length} source files)`)}`,
  );
  await runLocalChecks(io, bundle, sources, me.limits);

  const bot = existing ?? (await createBot(api, botName(project), slug, io, remote));
  const request: DeployRequest = {
    bundle: bundle.code,
    sources: sources.map(({ path, content }) => ({ path, content })),
    meta: deployMeta(project.root, values.message),
  };
  const deployed = await upload(api, bot.slug, request, io, remote).catch((e: unknown) => {
    if (e instanceof ApiError && e.code === "bot_not_found") throw noSuchBot(me, slug, server);
    throw explain(e, server);
  });
  const { version, quota } = deployed;
  const page = botPage(server, me.user.username, bot.slug, version.n);
  const left = quota.deploysPerDay - quota.deploysToday;
  io.out(
    `${green("✓")} uploaded ${bold(`${bot.slug} v${version.n}`)} ${dim(`(${left} of ${quota.deploysPerDay} deploys left today)`)}`,
  );

  if (!values.wait) {
    io.out(`The server is checking it. Follow along with \`zerosnake status\` or at ${cyan(page)}`);
    return EXIT.ok;
  }
  const final = await waitForChecks(api, version, io, remote);
  return reportOutcome(final, page, io);
}

/** `POST /api/bots`; a 409 `bot_exists` (a retry after a lost answer, or a race) is fine too. */
async function createBot(
  api: Api,
  name: string,
  slug: string,
  io: Io,
  remote: Remote,
): Promise<BotInfo> {
  try {
    const bot = await withRetries(remote, () =>
      api.call<BotInfo>("POST", "/api/bots", { body: { name, slug } }),
    );
    io.out(`${green("✓")} created the bot ${bold(bot.slug)}`);
    return bot;
  } catch (e) {
    if (e instanceof ApiError && e.code === "bot_exists" && e.body?.bot) return e.body.bot;
    throw explain(e, api.server);
  }
}

function deployMeta(root: string, message: string | undefined): DeployMeta {
  const meta: DeployMeta = { cliVersion: cliVersion().slice(0, 32) };
  const sdk = join(root, "node_modules", "@zerosnake", "sdk", "package.json");
  const sdkVersion = existsSync(sdk) ? readJson(sdk).version : undefined;
  if (typeof sdkVersion === "string") meta.sdkVersion = sdkVersion.slice(0, 32);
  if (message) meta.message = message;
  return meta;
}

/**
 * Uploads with one `Idempotency-Key` for this run and all its retries, so a retry after a lost
 * answer or a dropped connection never makes a second version, and a request that died on the
 * server half way is taken over instead of staying `validating` forever.
 */
export function upload(
  api: Api,
  slug: string,
  body: DeployRequest,
  io: Io,
  remote: Remote,
): Promise<DeployResponse> {
  const key = crypto.randomUUID();
  io.progress?.(`Uploading to ${api.server}…`);
  return withRetries(
    remote,
    () =>
      api.call<DeployResponse>("POST", `/api/bots/${encodeURIComponent(slug)}/versions`, {
        body,
        headers: { "idempotency-key": key },
        timeoutMs: 120_000,
      }),
    {
      onRetry: (e, delay) => {
        const why =
          e instanceof NetworkError
            ? e.reason
            : e instanceof ApiError && e.code === "deploy_in_progress"
              ? "the server is still processing the first attempt"
              : `HTTP ${(e as ApiError).status}`;
        io.err(yellow(`Upload didn't go through (${why}); retrying in ${delay / 1000}s…`));
      },
    },
  ).finally(() => io.progress?.(""));
}

/** Polls the version until it leaves `validating`, or {@link WAIT_MS} passes. */
export async function waitForChecks(
  api: Api,
  version: VersionInfo,
  io: Io,
  remote: Remote,
): Promise<VersionInfo> {
  const started = remote.now();
  const label = `${version.bot.slug} v${version.n}`;
  if (!io.progress) io.err(dim(`Waiting for the server to check ${label}…`));
  let current = version;
  let trouble = "";
  try {
    while (current.status === "validating") {
      const elapsed = remote.now() - started;
      if (elapsed >= WAIT_MS) {
        throw new CliError(
          `The server is still checking ${label} after ${Math.round(elapsed / 60_000)} minutes. ` +
            "The checks go on without the CLI: see `zerosnake status` later.",
        );
      }
      io.progress?.(
        `Checking ${label} on the server… ${Math.round(elapsed / 1000)}s ${dim("(Ctrl+C stops waiting; the checks go on)")}${trouble}`,
      );
      await remote.sleep(POLL_MS);
      try {
        current = await api.call<VersionInfo>(
          "GET",
          `/api/bots/${encodeURIComponent(version.bot.slug)}/versions/${version.n}`,
        );
        trouble = "";
      } catch (e) {
        if (!(e instanceof NetworkError) && !(e instanceof ApiError && e.status >= 500)) {
          throw explain(e, api.server);
        }
        trouble = yellow(" (connection trouble, retrying)");
      }
    }
  } finally {
    io.progress?.("");
  }
  return current;
}

function reportOutcome(version: VersionInfo, page: string, io: Io): number {
  const label = `${version.bot.slug} v${version.n}`;
  const report = formatReport(version.report);
  switch (version.status) {
    case "ready":
      io.out(`${green("✓")} ${bold(label)} passed the checks and is live in the arena.`);
      if (report.length) io.out(report.join("\n"));
      io.out(`Watch it at ${cyan(page)}`);
      return EXIT.ok;
    case "archived":
      io.out(
        `${green("✓")} ${bold(label)} passed the checks, but a newer version replaced it already.`,
      );
      return EXIT.ok;
    default:
      io.err(`${red("✗")} ${bold(label)} was rejected:`);
      io.err(report.length ? report.join("\n") : "  (no report)");
      io.err(
        "\nNothing changed in the arena. Fix the problem, try `zerosnake test`, and deploy again.",
      );
      return EXIT.failure;
  }
}
