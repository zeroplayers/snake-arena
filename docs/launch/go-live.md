# Go live: publishing the repo and the CLI

The steps only the owner can take (accounts and visibility), in order, with the commands. What
they depend on is done:

- the site and the CLI already point at `https://zerosnake.dev` (#90);
- `packages/cli` is publishable (version 0.1.0, MIT, repository metadata, LICENSE in the
  package). The packed tarball was checked outside the monorepo:
  `npx --package=zerosnake-0.1.0.tgz zerosnake init my-snake`, then `sim` and `test` in the new
  project, all pass.

The launch copy is in [kit.md](kit.md).

## 1. Claim the names (today)

```bash
npm login
npm org create zerosnake          # the @zerosnake scope, for later packages
```

## 2. Publish the CLI

```bash
pnpm install && pnpm test
cd packages/cli
pnpm publish --access public     # runs the build (prepack); rewrites workspace:* devDependencies
npm view zerosnake version       # 0.1.0
```

Then, in an empty folder on macOS and on Linux or WSL: `npx zerosnake init my-snake`,
`cd my-snake`, `npx zerosnake sim`, `npx zerosnake test`.

## 3. Flip the site's flags and make the repo public

In [`apps/web/src/site.ts`](../../apps/web/src/site.ts): `REPO.public = true` and
`CLI_PUBLISHED = true`, merge, and let the deploy run. Then:

```bash
gh repo edit zeroplayers/snake-arena --visibility public --accept-visibility-change-consequences
gh repo edit zeroplayers/snake-arena \
  --description "Your snake bot vs. everyone else's: a slither.io-style arena where every snake is code" \
  --homepage "https://zerosnake.dev" \
  --add-topic slither-io,game-ai,programming-game,quickjs,cloudflare-workers,claude-code \
  --enable-discussions
```

By hand in the repository's Settings:

- **Social preview**: upload `apps/web/public/og.jpg`.
- **Code security → Private vulnerability reporting**: on ([`SECURITY.md`](../../SECURITY.md)
  links to it).

## 4. Check

- The landing page shows no "Coming at launch" or "Not on npm yet", and its GitHub links work.
- "Copy prompt for Claude", pasted into Claude Code in an empty folder, ends in a deployed bot.
- Link previews on `https://zerosnake.dev`: X, LinkedIn Post Inspector, Facebook Sharing
  Debugger, Slack.
- Then the soft open and launch-day checklist in [kit.md](kit.md#launch-day-checklist).
