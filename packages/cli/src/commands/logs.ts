import {
  type LifeSummary,
  type LivesResponse,
  type MeResponse,
  printable,
  TRACE_RETENTION_DAYS,
  type TraceResponse,
  type TraceTick,
  type VersionInfo,
} from "@zerosnake/web/shared";
import { formatReport } from "../artifact.ts";
import { CliError, EXIT, UsageError } from "../errors.ts";
import { type Io, intOption, parse } from "../io.ts";
import { findProject } from "../project.ts";
import {
  type Api,
  ApiError,
  defaultRemote,
  explain,
  type Remote,
  signedInApi,
} from "../remote/api.ts";
import { botPage, botSlug, findBot, type MeBot } from "../remote/bots.ts";
import { DEFAULT_URL, serverUrl } from "../remote/config.ts";
import { bold, cyan, dim, green, red, yellow } from "../term.ts";

/** Deaths whose context `--deaths` prints. */
export const DEATH_CONTEXTS = 3;
export const DEFAULT_CONTEXT = 10;

export const LOGS_HELP = `Usage: zerosnake logs [options]

Shows a version of your bot: its status, its check report, and its recent lives with how each
one ended. With --deaths, also why the latest ones died: the last ticks before each death, from
the life's trace (what the bot saw, what it returned, what it cost, what it logged). Traces are
kept ${TRACE_RETENTION_DAYS} days and only you can read your bots' traces.

Options:
  --bot <slug>     Which bot (default: this project's, as for deploy)
  --version <n>    Which version (default: the active one, else the latest)
  --deaths         Only lives that ended, with the death context of the latest ${DEATH_CONTEXTS}
  --life <id>      The death context of one life (an id from the list or a replay URL)
  --context <n>    Ticks of death context to show (default ${DEFAULT_CONTEXT}, max 100)
  --url <url>      Server (default: ${DEFAULT_URL}, or ZEROSNAKE_URL)
  -h, --help       Show this help`;

const OPTIONS = {
  bot: { type: "string" },
  version: { type: "string" },
  deaths: { type: "boolean" },
  life: { type: "string" },
  context: { type: "string" },
  url: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

export const LIVES_LIMIT = 20;

/** A life as `GET /api/bots/:bot/versions/:n/lives` lists it. */
export type LifeEntry = LifeSummary;

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
  const context = intOption(values.context, "context", 1) ?? DEFAULT_CONTEXT;
  if (context > 100) throw new UsageError(`--context is at most 100 ticks, got ${context}`);
  const server = serverUrl(values.url, remote.env);
  const api = signedInApi(server, remote);
  if (values.life !== undefined) {
    const id = lifeId(values.life);
    const trace = await fetchTrace(api, id, server);
    if (typeof trace === "string") throw new CliError(trace);
    io.out(formatDeathContext(trace, context, server).join("\n"));
    return EXIT.ok;
  }
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
  if (version.quarantine) {
    io.out(
      `\n${red("Quarantined by the arena")} on ${new Date(version.quarantine.at).toLocaleString()}: it gets no new lives until reviewed.\n  ${version.quarantine.reason}`,
    );
  }
  const report = formatReport(version.report);
  if (report.length > 0) io.out(`\nChecks:\n${report.join("\n")}`);
  if (version.status === "rejected" || version.status === "validating") return EXIT.ok;

  let lives: LifeEntry[];
  try {
    const query = `?limit=${LIVES_LIMIT}${values.deaths ? "&deaths=1" : ""}`;
    lives = (await api.call<LivesResponse>("GET", `${base}/lives${query}`)).lives;
  } catch (e) {
    // An older server without the route answers with its HTML 404 page, not a JSON API error.
    if (e instanceof ApiError && !e.body && (e.status === 404 || e.status === 405)) {
      io.out(
        `\nThis server can't list lives yet. Recent lives and causes of death are on the bot's page:\n  ${cyan(page)}`,
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
  if (!values.deaths) return EXIT.ok;

  const traced = lives.filter((l) => l.endedAt !== null && l.hasTrace !== false);
  for (const life of traced.slice(0, DEATH_CONTEXTS)) {
    const trace = await fetchTrace(api, life.id, server);
    io.out("");
    if (typeof trace === "string") io.out(`${bold(`Life ${life.id}`)}: ${dim(trace)}`);
    else io.out(formatDeathContext(trace, context, server).join("\n"));
  }
  if (traced.length > DEATH_CONTEXTS) {
    io.out(
      dim(
        `\nOlder deaths: zerosnake logs --life <id> (traces are kept ${TRACE_RETENTION_DAYS} days).`,
      ),
    );
  }
  return EXIT.ok;
}

/** A life id, or the id at the end of a replay URL (`…/replay/<id>`). */
function lifeId(arg: string): string {
  const id = arg.replace(/\/+$/, "").split("/").at(-1) ?? "";
  if (!id) throw new UsageError(`--life needs a life id, got "${arg}"`);
  return id;
}

/** The life's trace, or why there is none (a sentence for people). */
async function fetchTrace(api: Api, id: string, server: string): Promise<TraceResponse | string> {
  try {
    return await api.call<TraceResponse>("GET", `/api/lives/${encodeURIComponent(id)}/trace`);
  } catch (e) {
    if (e instanceof ApiError) {
      const code = e.body?.error;
      // Answers about this one life: `--deaths` goes on with the next, `--life` stops.
      if (
        code === "trace_expired" ||
        code === "trace_not_found" ||
        code === "life_not_found" ||
        code === "not_life_owner"
      ) {
        return e.body?.message ?? code;
      }
      if (!e.body && e.status === 404) return "This server can't show traces yet.";
    }
    throw explain(e, server);
  }
}

/**
 * The death context of a life: how it ended, totals over the whole life, then its last `ticks`
 * ticks: what the bot saw (summarized), what it returned, what that cost and what it logged.
 */
export function formatDeathContext(trace: TraceResponse, ticks: number, server: string): string[] {
  const lifeTicks = trace.endTick - trace.startTick;
  const ending = lifeEnding({ deathCause: causeOf(trace.cause), killer: trace.killerName });
  const out = [
    `${bold(`Life ${trace.lifeId}`)}: ${ending} at room tick ${trace.endTick}, after ${lifeTicks} ticks`,
  ];
  const t = trace.totals;
  const mean = t.ticks ? t.sumWork / t.ticks : 0;
  const faults = [
    t.errors ? red(`${t.errors} errors`) : "0 errors",
    t.timeouts ? red(`${t.timeouts} timeouts`) : "0 timeouts",
  ];
  out.push(
    `  ${t.ticks} bot calls, ${faults.join(", ")}; cost per tick: peak ${percent(t.maxWork, trace.budget.work)}, mean ${percent(mean, trace.budget.work)} of the budget, up to ${t.maxOps}/${trace.budget.ops} ops`,
  );
  if (trace.restarts.length > 0) {
    out.push(
      yellow(
        `  The room restarted at tick ${trace.restarts.join(", ")}: the bot ran init() again there, with empty memory.`,
      ),
    );
  }
  // Logs and errors are the bot's own text: printed only once nothing in them can drive the
  // terminal (the room cleans them too; this doesn't trust the server to).
  for (const line of trace.load.log) out.push(`  ${dim("init log:")} ${printable(line)}`);
  if (trace.load.error) out.push(`  ${red("init error:")} ${printable(trace.load.error)}`);
  const shown = trace.full.slice(-ticks);
  out.push(dim(`  Last ${shown.length} ticks (life tick, then what it saw | returned | cost):`));
  for (const tick of shown) out.push(...formatTick(tick, trace.budget.work));
  out.push(dim(`  replay: ${server}/replay/${trace.lifeId}`));
  return out;
}

function formatTick(t: TraceTick, budget: number): string[] {
  const s = t.seen;
  let near = "no snakes";
  if (s.nearest) {
    const n = s.nearest;
    const what = `@${n.author} ${n.head ? "HEAD" : "body"} (length ${n.length}) gap ${n.gap}`;
    near = `${s.snakes} snakes, nearest ${n.gap < 1 ? red(what) : what}`;
  }
  const food = s.foodDist === null ? "no food" : `${s.food} food, nearest ${s.foodDist}`;
  const act = `turn ${t.turn}${t.boost ? " boost" : ""}`;
  const cost = `${percent(t.work, budget)}, ${t.ops} ops`;
  const outcome = t.outcome === "ok" ? "" : ` ${red(t.outcome)}`;
  const lines = [
    `  [${t.lifeTick}] head (${s.x}, ${s.y}) angle ${s.angle} length ${s.length} wall ${s.wall} | ${near} | ${food} | ${act} | ${cost}${outcome}`,
  ];
  for (const line of t.log) lines.push(`      ${dim("log:")} ${printable(line)}`);
  if (t.logCut) lines.push(`      ${dim("log: … (cut at the per-tick limit)")}`);
  if (t.error) lines.push(`      ${red("error:")} ${printable(t.error)}`);
  return lines;
}

function percent(n: number, of: number): string {
  if (of <= 0) return "-";
  const p = (100 * n) / of;
  return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

function causeOf(cause: string): LifeEntry["deathCause"] {
  return cause === "collision" ||
    cause === "wall" ||
    cause === "timeout" ||
    cause === "error" ||
    cause === "retired"
    ? cause
    : null;
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
