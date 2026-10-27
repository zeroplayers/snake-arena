import type { MeResponse } from "@zerosnake/web/shared";
import { EXIT, UsageError } from "../errors.ts";
import { type Io, parse } from "../io.ts";
import { Api, defaultRemote, explain, localTime, type Remote, signedInApi } from "../remote/api.ts";
import { botPage, findBot, type MeBot } from "../remote/bots.ts";
import { DEFAULT_URL, serverUrl } from "../remote/config.ts";
import { bold, dim, green, red, yellow } from "../term.ts";

export const STATUS_HELP = `Usage: zerosnake status [options]

Shows who you're logged in as, each of your bots with its active version, rating and lives,
and how many deploys you have left today.

Options:
  --bot <slug>   Only this bot
  --url <url>    Server (default: ${DEFAULT_URL}, or ZEROSNAKE_URL)
  -h, --help     Show this help`;

const OPTIONS = {
  bot: { type: "string" },
  url: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

/** A version is ranked once its rating covers this many lives (`RANKED_MIN_LIVES`, apps/web). */
export const RANKED_MIN_LIVES = 30;

/**
 * A bot on the public profile, `GET /api/users/:username` (`BotSummary` in
 * apps/web/src/lib/api.ts, which `@zerosnake/web/shared` doesn't export). The CLI API has no
 * rating yet, so `status` reads it here.
 */
export interface PublicBot {
  slug: string;
  activeVersion: number | null;
  /** Mean score of the active version over its last 200 lives; `null` until rated. */
  rating: number | null;
  /** Half-width of the 95% confidence interval. */
  ratingCi: number | null;
  ratedLives: number | null;
  /** Every life of every version. */
  lives: number;
}

export async function statusCommand(
  argv: string[],
  io: Io,
  remote: Remote = defaultRemote(),
): Promise<number> {
  const { values, positionals } = parse(argv, OPTIONS, "status");
  if (values.help) {
    io.out(STATUS_HELP);
    return EXIT.ok;
  }
  if (positionals.length > 0) {
    throw new UsageError(`Unexpected argument "${positionals[0]}". Use --bot <slug> for one bot.`);
  }
  const server = serverUrl(values.url, remote.env);
  const api = signedInApi(server, remote);
  const me = await api.call<MeResponse>("GET", "/api/me").catch((e: unknown) => {
    throw explain(e, server);
  });
  const username = me.user.username;
  const bots = values.bot ? [findBot(me, values.bot.toLowerCase(), server)] : me.bots;
  const ratings = username ? await publicBots(server, username, remote) : null;

  io.out(`Logged in to ${server} as ${bold(username ? `@${username}` : me.user.name)}`);
  if (me.bots.length === 0) {
    io.out("\nNo bots yet. Create one with `zerosnake deploy --create` in your bot's folder.");
  }
  for (const bot of bots) {
    io.out("");
    io.out(describeBot(bot, ratings?.get(bot.slug), ratings !== null, server, username, remote));
  }

  const { deploysToday, deploysPerDay, resetsAt } = me.quota;
  const left = Math.max(0, deploysPerDay - deploysToday);
  io.out(
    `\nDeploys today: ${deploysToday} of ${deploysPerDay}, ${left === 0 ? red("none left") : `${left} left`} ${dim(`(resets at ${localTime(resetsAt)})`)}`,
  );
  return EXIT.ok;
}

/** Ratings by slug from the public profile, or `null` if it couldn't be read. */
async function publicBots(
  server: string,
  username: string,
  remote: Remote,
): Promise<Map<string, PublicBot> | null> {
  try {
    const profile = await new Api(server, remote).call<{ bots: PublicBot[] }>(
      "GET",
      `/api/users/${encodeURIComponent(username)}`,
    );
    return new Map(profile.bots.map((b) => [b.slug, b]));
  } catch {
    return null;
  }
}

function describeBot(
  bot: MeBot,
  rated: PublicBot | undefined,
  haveRatings: boolean,
  server: string,
  username: string | null,
  remote: Remote,
): string {
  const lines = [`${bold(bot.name)} ${dim(botPage(server, username, bot.slug))}`];
  const row = (label: string, text: string) => lines.push(`  ${label.padEnd(8)} ${text}`);
  row(
    "active",
    bot.activeVersion === null ? dim("none (not in the arena)") : `v${bot.activeVersion}`,
  );
  const latest = bot.latestVersion;
  if (latest && latest.n !== bot.activeVersion) {
    const status =
      latest.status === "validating"
        ? yellow("validating")
        : latest.status === "rejected"
          ? red("rejected")
          : latest.status;
    row("latest", `v${latest.n} · ${status} · deployed ${ago(latest.createdAt, remote.now())}`);
  }
  if (bot.activeVersion !== null) {
    if (!haveRatings) row("rating", dim("couldn't be loaded"));
    else row("rating", describeRating(rated));
    if (rated) row("lives", `${rated.lives.toLocaleString("en-US")} played (all versions)`);
  }
  return lines.join("\n");
}

export function describeRating(bot: PublicBot | undefined): string {
  if (!bot || bot.rating === null || bot.ratedLives === null) return dim("not rated yet");
  const value = `${bot.rating.toFixed(1)} ± ${(bot.ratingCi ?? 0).toFixed(1)}`;
  return bot.ratedLives >= RANKED_MIN_LIVES
    ? `${bold(value)} over ${bot.ratedLives} lives · ${green("ranked")}`
    : `${value} over ${bot.ratedLives} lives · unranked until ${RANKED_MIN_LIVES} lives`;
}

/** `5 min ago`, `3 h ago`, `2 days ago`. */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const days = Math.floor(s / 86_400);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
