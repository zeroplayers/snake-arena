# Launch checklist (owner)

The steps only the owner can take, in order, with the commands: open the repository, publish the
CLI, flip the site's flags, announce. Everything else is done: the
[open-source audit](open-source-audit.md) found nothing that blocks opening the repository, and
`packages/cli` packs into a self-contained `zerosnake` that was installed and run outside the
monorepo. Copy and the launch-day details are in [kit.md](kit.md).

Run the commands from a checkout of `main` unless a step says otherwise.

**Relation to `go-live.md`.** PR #88 adds `docs/launch/go-live.md` with the same owner steps, and
PR #89 (stacked on it) flips the flags. This checklist agrees with both and adds the audit, the
security settings, trusted publishing and the clean-machine check. Where they differ, follow this
file: npm orgs are created on npmjs.com (`npm org create` doesn't exist), and the flags flip
**after** the repository is public and the CLI is on npm, as #89's description says (go-live.md's
step 4 flips them first). Once #88 is merged, go-live.md can link here instead of repeating the
steps.

## 1. Review the audit

Read the verdict in [open-source-audit.md](open-source-audit.md) and decide:

- [ ] Issue #80 (plaintext device codes): fix before launch, or accept that it is public.
- [ ] Commit email `bromkrololo@gmail.com` in history: accept, and use the GitHub noreply address
  from now on:

  ```bash
  git config --global user.email "<id>+oleksiisurnin@users.noreply.github.com"   # github.com/settings/emails shows it
  ```

- [ ] PR #88's `marketing/LAUNCH_PLAN.md` and `marketing/reviews/`: keep, or take them out of the
  PR first.
- [ ] The spike Worker `zerosnake-spike-quickjs`: delete it if it is still deployed
  (`pnpm exec wrangler delete --name zerosnake-spike-quickjs` from `spikes/quickjs-do`).
- [ ] `LICENSE` holder: keep "ZeroPlayers contributors" or switch to "Surnin Synergy Ltd and
  contributors" (then ask Claude to change `LICENSE` and `packages/cli/LICENSE` together).

## 2. Domain, GitHub sign-in, analytics

The CLI bakes its default server into the published package, so the domain must be final before
step 4. If the domain move (#90, PR #91) isn't finished:

- [ ] Merge PR #91 and let the staging deploy run.
- [ ] Cloudflare API token for CI: add zone `zerosnake.dev` (Workers Routes: Edit, DNS: Edit).
- [ ] GitHub sign-in app: homepage and callback URL on the live site's domain
  (`https://<site>/api/auth/callback/github`); try "Sign in with GitHub" on the live site.
- [ ] Cloudflare Web Analytics: add the site for the live domain and put its token in
  `CF_BEACON_TOKEN` (`apps/web/wrangler.jsonc`, ask Claude to open the PR).
- [ ] Decide which URL the CLI should talk to for good. Check what `main` has:

  ```bash
  grep -n 'DEFAULT_URL =' packages/cli/src/remote/config.ts
  ```

  #91 sets `https://staging.zerosnake.dev`. If the launch site is `https://zerosnake.dev`, ask
  Claude to change `DEFAULT_URL` (and `SITE_URL`, `robots.txt`, `sitemap.xml`) first.

## 3. Make the repository public

Before flipping, in a terminal with `gh` signed in as an admin of `zeroplayers`:

```bash
git switch main && git pull
gh pr list --state open        # anything open becomes public too (see the audit)
```

Then:

```bash
gh repo edit zeroplayers/snake-arena --visibility public --accept-visibility-change-consequences
```

Right after:

```bash
# Private vulnerability reporting (SECURITY.md links to it; only public repos can have it)
gh api -X PUT repos/zeroplayers/snake-arena/private-vulnerability-reporting
# Workflows from forks wait for your approval unless the author is a collaborator
gh api -X PUT repos/zeroplayers/snake-arena/actions/permissions/fork-pr-contributor-approval \
  -f approval_policy=all_external_contributors
# Delete head branches after merge; description, homepage, topics
gh repo edit zeroplayers/snake-arena --delete-branch-on-merge \
  --description "Your snake bot vs. everyone else's: a slither.io-style arena where every snake is code" \
  --homepage "https://zerosnake.dev" \
  --add-topic slither-io,snake,game-ai,programming-game,ai-arena,quickjs,cloudflare-workers,claude-code
```

By hand on github.com → the repository → **Settings**:

- [ ] General → Social preview: upload `apps/web/public/og.jpg`.
- [ ] Code security: Dependabot alerts and secret scanning on (free for public repositories).
- [ ] Check github.com/zeroplayers/snake-arena/community: README, code of conduct, contributing,
  license, security policy, issue and PR templates all ticked.

## 4. Publish the CLI to npm

You need an npmjs.com account with two-factor authentication on ("Authorization and writes").

```bash
npm login                      # opens the browser
npm whoami
```

Claim the scope, so nobody else can publish `@zerosnake/*` (the CLI lists them as dev
dependencies, and the SDK may be published there later): npmjs.com → your avatar → **Add
Organization** → name `zerosnake` (free, public packages). `npm` itself can't create orgs.

Build, check and publish exactly the tarball you checked:

```bash
git switch main && git pull
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test
cd packages/cli
pnpm build
grep -n 'var DEFAULT_URL' dist/cli.js            # must print the URL from step 2
rm -rf /tmp/zerosnake-pack && pnpm pack --pack-destination /tmp/zerosnake-pack
tar -tzf /tmp/zerosnake-pack/zerosnake-0.1.0.tgz # bin/, dist/, LICENSE, README.md, package.json
npm publish /tmp/zerosnake-pack/zerosnake-0.1.0.tgz --access public   # asks for 2FA
npm view zerosnake version                       # 0.1.0
```

`pnpm pack` runs the build again (`prepack`) and replaces the `workspace:*` dev dependencies with
versions; publishing the tarball with `npm` uploads exactly what you listed.

Then, for later releases without tokens, on npmjs.com → **zerosnake** → Settings:

- [ ] **Trusted Publisher** → GitHub Actions: organization or user `zeroplayers`, repository
  `snake-arena`, workflow filename `release-cli.yml`, environment `npm`.
- [ ] **Publishing access** → "Require two-factor authentication and disallow tokens".
- [ ] Optional: GitHub → Settings → Environments → `npm` → required reviewers: you. Then each
  release waits for your click.

A later release: bump `version` in `packages/cli/package.json` in a PR, merge, then

```bash
git switch main && git pull
git tag cli-v0.1.1 && git push origin cli-v0.1.1
```

[`.github/workflows/release-cli.yml`](../../.github/workflows/release-cli.yml) checks the tag
against the version, runs the CLI's tests (including the packed-install test) and publishes with
provenance.

## 5. Flip the site's flags

Only once **both** step 3 and step 4 are done: merge PR #89 (after #88), which sets
`REPO.public` and `CLI_PUBLISHED` to `true` in `apps/web/src/site.ts`. If #88 isn't going in,
tell Claude instead:

> Flip the launch flags for zeroplayers/snake-arena#31: in `apps/web/src/site.ts` set
> `REPO.public` to `true` and `CLI_PUBLISHED` to `true`, run lint, typecheck and the web tests,
> and open a PR into main.

Either way it's only those two values: `landing.test.tsx` (same change as in #89) already passes
with every combination of the flags. Let the deploy run, then on the live site:

- [ ] No "Coming at launch" or "Not on npm yet"; the GitHub links work; "Copy first steps"
  copies one line.

## 6. Check from a clean machine

On a machine (or container) that never had the CLI. Linux, in Docker:

```bash
docker run --rm node:24 sh -c "npx --yes zerosnake@0.1.0 init my-snake && cd my-snake && npx --yes zerosnake@0.1.0 sim --headless --seed 1 && npx --yes zerosnake@0.1.0 test"
```

On your Mac, in an empty folder:

```bash
npx --yes zerosnake@latest init my-snake
cd my-snake
npx zerosnake sim
npx zerosnake login
npx zerosnake deploy --create
```

- [ ] The viewer opens, `login` signs in with GitHub, the deploy goes `ready` and the bot shows on
  the leaderboard.
- [ ] "Copy prompt for Claude" from the landing page, pasted into Claude Code in an empty folder,
  ends in a deployed bot.
- [ ] Windows or WSL if you can.

## 7. Announce

In the order of [kit.md → Launch-day checklist](kit.md#launch-day-checklist):

1. **Soft open** first if there's time: invite 30–50 people, get bots on the leaderboard and a
   live showcase room ("Live from the arena" in the hero).
2. **The day before**: preview cards on the live URL (X, LinkedIn Post Inspector, Facebook
   Sharing Debugger, Slack, Discord); PH draft scheduled.
3. **Product Hunt** at 00:01 PT, maker comment right away ([kit.md → Product Hunt](kit.md#product-hunt)).
4. **X thread** once the PH page is live; pin it ([kit.md → X thread](kit.md#x-thread)).
5. **Show HN** on a different day from PH, mid-morning US Eastern, first comment posted at once
   ([kit.md → Show HN](kit.md#show-hn)).
6. **Reddit** over the following week, one subreddit at a time, by each sub's rules
   ([kit.md → Reddit](kit.md#reddit)).

Never ask for upvotes or link straight to the PH or HN thread asking for support.
