import { CLI_PUBLISHED, REPO, SITE_URL } from "../../site";

/**
 * The "Copy prompt for Claude" text: pasted into Claude Code (or any coding agent) in an empty
 * folder, it takes a first-time visitor from nothing to a deployed bot. It follows the template's
 * own rules (`template/CLAUDE.md`: never plain `sim`, never invent output), and leaves `login` to
 * the person, since it opens their browser and waits for them.
 *
 * While the CLI isn't on npm but the repository is public, it runs the CLI from a checkout
 * (`docs/getting-started.md`, "Before the packages are published"). While both are closed it reads
 * as it will on launch day; the page shows it without a copy button then.
 */
export function claudePrompt(
  flags: { cli: boolean; repo: boolean } = { cli: CLI_PUBLISHED, repo: REPO.public },
): string {
  const fromCheckout = !flags.cli && flags.repo;
  // The CLI as run inside the bot's folder.
  const cli = fromCheckout ? "node ../snake-arena/packages/cli/bin/zerosnake.js" : "npx zerosnake";
  const setup = fromCheckout
    ? `1. The zerosnake CLI isn't on npm yet, so build it from source here: \`git clone ${REPO.url}\`, then in \`snake-arena\` run \`npx pnpm@11 install\` and \`npx pnpm@11 --filter zerosnake build\`. Back here, run \`node snake-arena/packages/cli/bin/zerosnake.js init my-snake\` and work inside \`my-snake\`.`
    : "1. Run `npx zerosnake init my-snake` here, then work inside `my-snake`.";
  return `Help me build a snake bot for ZeroSnake Arena (${SITE_URL}) and get it into the arena. It's a slither.io-style game where bots written in TypeScript play each other. It needs Node.js 24+.

${setup}
2. Read \`CLAUDE.md\` and the skills in \`.claude/skills/\`, and follow them. In 3–4 sentences, tell me what a bot sees each tick and what it returns.
3. Ask me what kind of snake I want, or suggest two ideas, then change \`src/bot.ts\` to play it.
4. Run \`${cli} sim --headless\` and tell me how it did. I can watch a match myself with \`${cli} sim\` (it opens my browser).
5. Run \`${cli} test\`, the same checks the server runs, and fix anything that fails.
6. Ask me to run \`${cli} login\` myself in another terminal in this folder (or in Claude Code with \`! ${cli} login\`, though its output may only show when it finishes). It opens my browser to sign in with GitHub and shows a code to confirm; the first time, I pick a username. Wait until I say it's done.
7. Run \`${cli} deploy\` and give me the link to my bot's page that it prints.

Don't invent command output. If a step fails, show me the error and fix it.`;
}

/** Whether the prompt works if pasted today: the CLI is on npm, or the source is public. */
export function claudePromptWorks(
  flags: { cli: boolean; repo: boolean } = { cli: CLI_PUBLISHED, repo: REPO.public },
): boolean {
  return flags.cli || flags.repo;
}
