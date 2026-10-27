import type { MeResponse, VersionInfo } from "@zerosnake/web/shared";
import { formatReport } from "../artifact.ts";
import { CliError, EXIT, UsageError } from "../errors.ts";
import { type Io, intOption, parse } from "../io.ts";
import { findProject } from "../project.ts";
import { ApiError, defaultRemote, explain, type Remote, signedInApi } from "../remote/api.ts";
import { botPage, botSlug, findBot, type MeBot } from "../remote/bots.ts";
import { DEFAULT_URL, serverUrl } from "../remote/config.ts";
import { bold, cyan, dim, green, red, yellow } from "../term.ts";

export const LOGS_HELP = `Usage: zerosnake logs [options]

Shows a version of your bot: its status, its check report, and its recent lives with how each
one ended.

Options:
  --bot <slug>     Which bot (default: this project's, as for deploy)
  --version <n>    Which version (default: the active one, else the latest)
  --deaths         Only lives that ended
  --url <url>      Server (default: ${DEFAULT_URL}, or ZEROSNAKE_URL)
  -h, --help       Show this help`;

const OPTIONS = {
  bot: { type: "string" },
  version: { type: "string" },
  deaths: { type: "boolean" },
  url: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

export const LIVES_LIMIT = 20;

/**
 * One life, as `GET /api/bots/:bot/versions/:n/lives` would return it. That endpoint doesn't
 * exist yet (zeroplayers/snake-arena#25, with traces and death context); this is the shape the
 * CLI asks for, built from the `lives` table. Until it exists `logs` points at the bot's page,
 * which lists recent lives already.
 */
export interface LifeEntry {
  id: string;
  /** ISO 8601. */
  startedAt: string;
  endedAt: string | null;
  score: number;
  lengthMax: number;
  kills: number;
  deathCause: "collision" | "wall" | "timeout" | "error" | "retired" | null;
  /** Who it ran into, for people: `@user/bot v3` or `house bot hard`. */
  killer: string | null;
}

export interface LivesResponse {
  lives: LifeEntry[];
}

export async function logsCommand(
  argv: string[],
  io: Io,
  remote: Remote = defaultRemote(),
): Promise<number> {
  const { values, positionals } = parse(argv, OPTIONS, "logs");
  if (values.help) {
    io.out(LOGS_HELP);
    return EXIT.ok;
  }
  if (positionals.length > 0) {
    throw new UsageError(`Unexpected argument "${positionals[0]}". Use --bot and --version.`);
  }
  const wanted = intOption(values.version, "version", 1);
  const server = serverUrl(values.url, remote.env);
  const api = signedInApi(server, remote);
  const me = await api.call<MeResponse>("GET", "/api/me").catch((e: unknown) => {
    throw explain(e, server);
  });
  const bot = pickBot(me, values.bot, io.cwd, server);
  const n = wanted ?? bot.activeVersion ?? bot.latestVersion?.n;
  if (n === undefined) {
    throw new CliError(`${bot.slug} has no versions yet. Deploy one with \`zerosnake deploy\`.`);
  }
  const base = `/api/bots/${encodeURIComponent(bot.slug)}/versions/${n}`;
  const version = await api.call<VersionInfo>("GET", base).catch((e: unknown) => {
    throw explain(e, server);
  });
  const page = botPage(server, me.user.username, bot.slug, n);

  const status =
    version.status === "ready"
      ? green("ready (active)")
      : version.status === "rejected"
        ? red("rejected")
        : version.status === "validating"
          ? yellow("validating")
          : version.status;
  io.out(
    `${bold(`${bot.slug} v${n}`)} · ${status} · deployed ${new Date(version.createdAt).toLocaleString()}`,
  );
  if (version.meta?.message) io.out(`  ${dim(`"${version.meta.message}"`)}`);
  const report = formatReport(version.report);
  if (report.length > 0) io.out(`\nChecks:\n${report.join("\n")}`);
  if (version.status === "rejected" || version.status === "validating") return EXIT.ok;

  let lives: LifeEntry[];
  try {
    const query = `?limit=${LIVES_LIMIT}${values.deaths ? "&deaths=1" : ""}`;
    lives = (await api.call<LivesResponse>("GET", `${base}/lives${query}`)).lives;
  } catch (e) {
    // No such route yet: the site answers with its HTML 404 page, not a JSON API error.
    if (e instanceof ApiError && !e.body && (e.status === 404 || e.status === 405)) {
      io.out(
        `\nThe CLI can't list lives yet (zeroplayers/snake-arena#25). Recent lives and causes of death are on the bot's page:\n  ${cyan(page)}`,
      );
      return EXIT.ok;
    }
    throw explain(e, server);
  }
  if (values.deaths) lives = lives.filter((l) => l.endedAt !== null);
  if (lives.length === 0) {
    io.out(`\nNo ${values.deaths ? "deaths" : "lives"} yet. ${dim(page)}`);
    return EXIT.ok;
  }
  io.out(`\n${values.deaths ? "Recent deaths" : "Recent lives"}:`);
  for (const life of lives) io.out(describeLife(life, server));
  return EXIT.ok;
}

/**
 * `--bot`, else this project's bot (as `deploy` picks it), else your only bot. Lets `logs` work
 * from anywhere for most people.
 */
function pickBot(me: MeResponse, flag: string | undefined, cwd: string, server: string): MeBot {
  if (flag !== undefined) return findBot(me, flag.toLowerCase(), server);
  let slug: string | undefined;
  try {
    slug = botSlug(findProject(cwd), undefined);
  } catch {
    slug = undefined;
  }
  const mine = me.bots.find((b) => b.slug === slug);
  if (mine) return mine;
  const [only] = me.bots;
  if (only && me.bots.length === 1) return only;
  return findBot(me, slug ?? "", server);
}

export function describeLife(life: LifeEntry, server: string): string {
  const when = new Date(life.startedAt).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const stats = `score ${String(life.score).padStart(5)}  length ${String(life.lengthMax).padStart(4)}  kills ${life.kills}`;
  const end = life.endedAt === null ? green("alive") : lifeEnding(life);
  const replay = life.endedAt === null ? "" : `\n    ${dim(`replay: ${server}/replay/${life.id}`)}`;
  return `  ${when}  ${stats}  ${end}${replay}`;
}

export function lifeEnding(life: Pick<LifeEntry, "deathCause" | "killer">): string {
  switch (life.deathCause) {
    case "collision":
      return red(`ran into ${life.killer ?? "another snake"}`);
    case "wall":
      return red("hit the wall");
    case "timeout":
      return red("too slow: the sandbox stopped it for using too many ops");
    case "error":
      return red("crashed: it kept throwing errors");
    case "retired":
      return dim("retired at the life cap");
    default:
      return dim("ended");
  }
}
