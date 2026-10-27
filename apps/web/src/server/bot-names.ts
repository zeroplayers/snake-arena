/**
 * Bot names and slugs, shared by the CLI API (`POST /api/bots`) and the site's bot management.
 * The name is free text; the slug is the URL segment (`/@user/slug`) and the CLI handle, and
 * never changes once the bot exists.
 */

export const BOT_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const BOT_NAME_MAX = 40;

export type BotNameResult =
  | { ok: true; name: string; slug: string }
  | { ok: false; message: string };

/** Why `name` (trimmed) isn't an acceptable bot name, or `null`. */
export function botNameProblem(name: string) {
  return name.length === 0 || name.length > BOT_NAME_MAX || /\p{Cc}/u.test(name)
    ? `A bot name is 1–${BOT_NAME_MAX} characters, without control characters.`
    : null;
}

/** `name` lowercased, runs of anything but a-z and 0-9 turned into `-`, at most 32 characters. */
export function slugify(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
}

/** Checks a new bot's name and slug; the slug defaults to `slugify(name)`. */
export function parseBotName(input: { name: string; slug?: string | undefined }): BotNameResult {
  const name = input.name.trim();
  const problem = botNameProblem(name);
  if (problem) return { ok: false, message: problem };
  const slug = input.slug === undefined ? slugify(name) : input.slug.toLowerCase();
  if (!BOT_SLUG.test(slug)) {
    return {
      ok: false,
      message:
        input.slug === undefined
          ? `Can't make a slug from "${name}"; pass one: 1–32 of a-z, 0-9 and -, not starting or ending with -.`
          : "A slug is 1–32 of a-z, 0-9 and -, not starting or ending with -.",
    };
  }
  return { ok: true, name, slug };
}
