/**
 * The source repository. It is private until launch (zeroplayers/snake-arena#31): set `public`
 * then and the "soon" placeholders and the doc pages' links to repository files, issues and pull
 * requests become links. While it's private they render as plain text.
 */
export const REPO = {
  url: "https://github.com/zeroplayers/snake-arena",
  branch: "main",
  public: true,
} as const;

/**
 * Whether the `zerosnake` package is on npm (zeroplayers/snake-arena#31). Until it is, the
 * landing page shows the `npx zerosnake …` commands as coming at launch and offers no copy: the
 * name isn't registered, so a pasted snippet could run anyone's code.
 */
export const CLI_PUBLISHED = true;

/**
 * The live showcase's WebSocket on this site (`src/server/showcase.ts` proxies it to the arena):
 * the landing page's arena plays it when a showcase room is running.
 */
export const SHOWCASE_PATH = "/api/showcase";

/**
 * The site's public origin, for absolute URLs in link previews (`og:image` must be absolute).
 * The CLI's `DEFAULT_URL` must match (a test checks): published CLIs keep it, so it's permanent.
 */
export const SITE_URL = "https://zerosnake.dev";
