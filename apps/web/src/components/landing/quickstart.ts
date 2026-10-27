import { CLI_PUBLISHED, REPO } from "../../site";

export interface QuickstartCommand {
  cmd: string;
  note?: string;
}

/**
 * The quick start in two parts: what runs on your machine with no account, then what puts the
 * bot in the arena. The commands are those `docs/getting-started.md` lists and `packages/cli`
 * implements (`zerosnake --help`); `landing.test.ts` checks each `npx zerosnake` one exists.
 */
export const QUICKSTART: readonly { title: string; commands: readonly QuickstartCommand[] }[] = [
  {
    title: "Try it on your machine (no account)",
    commands: [
      { cmd: "npx zerosnake init my-snake", note: "starter bot, CLAUDE.md, AGENTS.md and skills" },
      { cmd: "cd my-snake" },
      { cmd: "npx zerosnake sim", note: "your snake vs the house bots, in your browser" },
      { cmd: "claude", note: 'then: "make my snake hunt smaller snakes"' },
    ],
  },
  {
    title: "Put it in the arena",
    commands: [
      { cmd: "npx zerosnake test", note: "the same checks the server runs" },
      { cmd: "npx zerosnake login", note: "opens your browser: sign in with GitHub" },
      { cmd: "npx zerosnake deploy", note: "it joins the arena when the checks pass" },
    ],
  },
];

/** Every quick-start command, in order. */
export const QUICKSTART_COMMANDS: readonly QuickstartCommand[] = QUICKSTART.flatMap(
  (part) => part.commands,
);

/**
 * What doesn't work yet. Empty, and the box gone, once `CLI_PUBLISHED` is set on launch day.
 */
export const NOT_YET: readonly { what: string; detail: string }[] = CLI_PUBLISHED
  ? []
  : [
      {
        what: "npx zerosnake",
        detail: REPO.public
          ? "won't run until the package is on npm. Until then, run the CLI from a checkout of the repository."
          : "won't run until launch day, when the package goes on npm and the repository opens.",
      },
    ];

/**
 * The first part's commands as one line, for the copy button (shown once `CLI_PUBLISHED`). One
 * line, because pasted lines would answer npx's "Ok to proceed?" and `sim` runs until Ctrl+C; it
 * leaves out `claude`, which is interactive and optional.
 */
export function quickstartScript(): string {
  return (QUICKSTART[0]?.commands ?? [])
    .filter((c) => c.cmd !== "claude")
    .map((c) => c.cmd)
    .join(" && ");
}
