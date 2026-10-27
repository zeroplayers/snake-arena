import { existsSync } from "node:fs";
import { join } from "node:path";
import type { MeResponse } from "@zerosnake/web/shared";
import { CliError, UsageError } from "../errors.ts";
import { readJson } from "../paths.ts";
import type { Project } from "../project.ts";

export type MeBot = MeResponse["bots"][number];

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** A bot slug the way the deploy API makes one from a name (`POST /api/bots` without `slug`). */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
}

/** The bot's name when `--create` makes it: the package name without its scope. */
export function botName(project: Project): string {
  return project.name.replace(/^@[^/]+\//, "");
}

/**
 * Which of your bots a project deploys to: `--bot`, else `"zerosnake": { "bot": "<slug>" }` in
 * its package.json, else the slug of its package name.
 */
export function botSlug(project: Project, flag: string | undefined): string {
  let slug = flag;
  if (slug === undefined) {
    const manifest = join(project.root, "package.json");
    const config = existsSync(manifest) ? readJson(manifest).zerosnake : undefined;
    const configured = (config as { bot?: unknown } | undefined)?.bot;
    slug = typeof configured === "string" ? configured : slugify(botName(project));
  }
  slug = slug.toLowerCase();
  if (!SLUG.test(slug)) {
    throw new UsageError(
      flag === undefined
        ? `Can't make a bot slug from "${project.name}". Pick one with --bot <slug>: 1–32 of a-z, 0-9 and -.`
        : `"${flag}" isn't a bot slug: 1–32 of a-z, 0-9 and -, not starting or ending with -.`,
    );
  }
  return slug;
}

/** `slug` among the signed-in author's bots, or an error that lists them. */
export function findBot(me: MeResponse, slug: string, server: string): MeBot {
  const bot = me.bots.find((b) => b.slug === slug);
  if (bot) return bot;
  throw noSuchBot(me, slug, server);
}

export function noSuchBot(me: MeResponse, slug: string, server: string): CliError {
  const who = me.user.username ? `@${me.user.username}` : "You";
  if (me.bots.length === 0) {
    return new CliError(
      `No bot "${slug}". ${who} has no bots on ${server} yet: \`npx zerosnake deploy\` creates it.`,
    );
  }
  return new CliError(
    `No bot "${slug}". ${who} has: ${me.bots.map((b) => b.slug).join(", ")}.\n` +
      `Deploy to one of them with --bot <slug>, or create "${slug}" with \`zerosnake deploy --create\`.`,
  );
}

/** Public page of a bot (a version of it with `n`). */
export function botPage(server: string, username: string | null, slug: string, n?: number) {
  if (!username) return server;
  return `${server}/@${username}/${slug}${n === undefined ? "" : `?v=${n}`}`;
}
