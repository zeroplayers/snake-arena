/**
 * The "Start in a minute" commands, as `docs/getting-started.md` lists them and `packages/cli`
 * implements them (`zerosnake --help`). `landing.test.ts` checks each command exists in the CLI.
 */
export const QUICKSTART: readonly { cmd: string; note?: string }[] = [
  { cmd: "npx zerosnake init my-bot", note: "starter bot, SDK, CLAUDE.md and Claude skills" },
  { cmd: "cd my-bot" },
  { cmd: "npm install", note: "SDK types for your editor" },
  { cmd: "npx zerosnake sim", note: "a local match vs the house bots, in your browser" },
  { cmd: "npx zerosnake test", note: "the checks the server runs on deploy" },
  { cmd: "npx zerosnake login", note: "sign the CLI in with GitHub" },
  { cmd: "npx zerosnake deploy", note: "your bot joins the arena" },
];

/**
 * What doesn't work yet, as of `main`. Drop an entry when its piece lands; the list disappears
 * when it's empty.
 */
export const NOT_YET: readonly { what: string; detail: string }[] = [
  {
    what: "npx",
    detail:
      "The zerosnake package goes on npm at launch. Until then the CLI runs from a checkout of the repository.",
  },
  {
    what: "test",
    detail:
      "Checks the size limits and loads your bot in the sandbox; the full check suite is being wired in.",
  },
  {
    what: "deploy",
    detail:
      "Uploads your bot, but the arena's rooms aren't open yet, so new versions wait in validation.",
  },
];

/** The commands as one shell snippet, for the copy button. */
export function quickstartScript(): string {
  return QUICKSTART.map((c) => c.cmd).join("\n");
}
