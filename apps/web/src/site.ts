/**
 * The source repository. It is private until launch (zeroplayers/snake-arena#31): set `public`
 * then and the "soon" placeholders and the doc pages' links to repository files, issues and pull
 * requests become links. While it's private they render as plain text.
 */
export const REPO = {
  url: "https://github.com/zeroplayers/snake-arena",
  branch: "main",
  public: false,
} as const;

/**
 * Whether the `zerosnake` package is on npm (zeroplayers/snake-arena#31). Until it is, the
 * landing page shows the `npx zerosnake …` commands as coming at launch and offers no copy: the
 * name isn't registered, so a pasted snippet could run anyone's code.
 */
export const CLI_PUBLISHED = false;
