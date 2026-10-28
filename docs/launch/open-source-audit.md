# Open-source audit

What becomes public when `zeroplayers/snake-arena` goes public (#31): every branch, tag and
pull-request ref, every commit's content and metadata, and every issue, pull request, comment and
review. Audited on 2026-10-28 against GitHub as it was then (`main` at `b400051`, 35 branches,
PRs #37–#89, issues #1–#90). The owner's steps are in [checklist.md](checklist.md).

## Verdict

**Safe to make public.** No credential, key or token is in any commit reachable from GitHub, in
any tracked file, or in any issue, pull request, comment or review. Nothing needs a history
rewrite. Four things to decide before (or knowingly accept), none of them a leak:

1. **Open issue #80** describes an unfixed weakness in detail: device codes are stored in
   plaintext in the D1 that apps/arena (which runs bot code) can read, so code with D1 read access
   could race the real CLI for a deploy token during the 10-minute window. Exploiting it needs a
   sandbox escape first (bots run in QuickJS with no bindings), so it is defense in depth, not an
   open door. Either fix it before launch, or accept that it is public (it is a reasonable thing
   to have in the open, with SECURITY.md next to it).
2. **Commit author email.** All 203 commits carry the owner's personal gmail address as author (and
   committer, except GitHub's own merge commits). Anyone can read it from a clone or
   `github.com/…/commit/<sha>.patch`. Rewriting history to change it would break every PR link;
   the usual answer is to accept it, and for future commits set
   `git config user.email <id>+oleksiisurnin@users.noreply.github.com` and turn on GitHub's "Block
   command line pushes that expose my email".
3. **Open PR #88 (and #89, stacked on it)** add `marketing/`. Its `LAUNCH_PLAN.md` is in Russian
   and calls itself an internal document for the author (schedule, channels, which bots to deploy
   on a separate account), and `marketing/reviews/` holds five critics' verbatim reviews of the
   launch copy. Nothing secret, but once public, the branch and `refs/pull/88/head` are readable
   by anyone. Keep it (build-in-public), or move those two items out of the PR before flipping
   visibility (later edits don't hide earlier commits of an open PR).
4. **Spike Worker.** `spikes/quickjs-do/RESULTS.md` names
   `zerosnake-spike-quickjs.surnin-synergy.workers.dev` (it answers 404 at `/` today). Delete the
   Worker if it is still deployed and unused, so nobody runs its benchmark on your account.

## How it was checked

- **Secret scanner over full history.** `gitleaks` v8.24.3 (Docker image
  `zricethezav/gitleaks:v8.24.3`) on a `git clone --mirror` of GitHub (all branches, `pr-assets/*`
  and every `refs/pull/*`: 179 commits scanned), and again on the local repository with all
  worktree branches (222 commits): `gitleaks git <repo> --log-opts=--all`. Findings: 2 (3 locally),
  all the same false positive: a fixed UUID used as an `Idempotency-Key` in
  `apps/web/src/server/cli-api.test.ts`.
- **Pattern grep over every added line in history** (`git log -p --all`, lockfile excluded):
  `-----BEGIN`, `sk-…`, `sk_live`, `ghp_`, `gho_`, `github_pat_`, `xox[abpr]-`, `AKIA…`,
  `CLOUDFLARE_API_TOKEN=`, `API_TOKEN=`, `client_secret`, `SESSION_SECRET`, long `Bearer` tokens,
  `npm_…`, `password = "…"`: no hits.
- **Every file ever added** (626 paths across all refs): no `.env`, `.dev.vars`, `.wrangler/`,
  database, key or certificate file was ever committed. `.gitignore` covers `.env*`, `.dev.vars`,
  `.wrangler/`, `node_modules/`, `dist/`. The only blobs over 300 KB are PR screenshots
  (`pr-assets/*` branches, `apps/web/docs/landing-full.jpg`) and `marketing/media/readme-arena.gif`
  (3.2 MB, PR #88).
- **Issues, pull requests, comments and reviews**: all 90 issues/PRs, their comments and PR
  reviews downloaded through the API (~540 KB of text) and searched for tokens, keys, emails,
  personal paths and hex ids, then read where something matched. All are by the owner.

## Tracked files

| What                                                                                | Where                                                                             | Verdict                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare account id `ee83…18a2`                                                   | `spikes/quickjs-do/wrangler.jsonc`, issue #16                                     | Not a secret: it appears in every dashboard URL and needs an API token to do anything.                                                                                                                                                                                                                                                                    |
| D1 database id, KV namespace id                                                     | `apps/*/wrangler.jsonc` (`env.staging`)                                           | Not secrets: identifiers, useless without an API token for the account.                                                                                                                                                                                                                                                                                   |
| `CF_BEACON_TOKEN`                                                                   | `apps/web/wrangler.jsonc` vars                                                    | Public by design (it is in every page's HTML).                                                                                                                                                                                                                                                                                                            |
| `.dev.vars.example`                                                                 | `apps/web`                                                                        | Names only, empty values.                                                                                                                                                                                                                                                                                                                                 |
| `seed/dev.sql`                                                                      | `apps/web`                                                                        | Local fake users (`*@seed.zerosnake.invalid`), never staging.                                                                                                                                                                                                                                                                                             |
| `hello@surninsynergy.com`, company number, registered office, `x.com/oleksiisurnin` | `apps/web/src/legal.ts`                                                           | Intended: shown on the legal pages and footer.                                                                                                                                                                                                                                                                                                            |
| "I'm Oleksii" in the Product Hunt copy                                              | `docs/launch/kit.md`                                                              | Intended (maker comment).                                                                                                                                                                                                                                                                                                                                 |
| Personal paths                                                                      | —                                                                                 | None in today's files. History has one: `SPEC.md` line 20 in the first commit (`276c8e3`) named the owner's local folder `~/Dropbox/SurninSynergy/zerosnake`; removed in `fe47c3e`. Harmless (a folder name, no username), not worth a rewrite. `/Users/ada` in `packages/cli/src/remote/config.test.ts` is a fixture; nothing local is in the built CLI. |
| Old hosts (`*.surninsynergy.dev`)                                                   | history, `docs/launch/review.md`                                                  | Public hosts; #91 (merged) moved everything to `zerosnake.dev`.                                                                                                                                                                                                                                                                                           |
| `spikes/quickjs-do`                                                                 | spike code and results                                                            | Fine to publish (benchmark, no data); see item 4 above about its Worker.                                                                                                                                                                                                                                                                                  |
| `SPEC.md` §9 cost estimate                                                          | "prices from memory, verify"                                                      | Not sensitive; already flagged in [review.md](review.md) as worth a re-check or a softer wording.                                                                                                                                                                                                                                                         |
| Old branches                                                                        | 30 `claude/*` branches, `pr-assets/*`, `launch-kit-model-battle`, `go-live-flags` | Scanned with the rest; nothing sensitive. Merged PRs' screenshots link to `pr-assets/*` and some `claude/*` branches, so **don't delete those** or the images in PR descriptions break. The other merged `claude/*` branches can go any time (GitHub's "Automatically delete head branches" setting does it for future PRs).                              |

## Repository files

| File                                                                              | State                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LICENSE`                                                                         | MIT, "Copyright (c) 2026 ZeroPlayers contributors". Valid, but "ZeroPlayers contributors" isn't a legal person. **Suggestion** (owner's call, not changed here): `Copyright (c) 2026 Surnin Synergy Ltd and contributors`, which matches the operator on the legal pages. The same text is copied into `packages/cli/LICENSE`. |
| `CONTRIBUTING.md`                                                                 | Present; now links the code of conduct and SECURITY.md.                                                                                                                                                                                                                                                                        |
| `SECURITY.md`                                                                     | **Added**: private report through GitHub or hello@surninsynergy.com, what's in scope. GitHub's private vulnerability reporting can only be turned on once the repository is public (checklist step 3).                                                                                                                         |
| `CODE_OF_CONDUCT.md`                                                              | **Added**: Contributor Covenant 2.1, reports to hello@surninsynergy.com.                                                                                                                                                                                                                                                       |
| `.github/ISSUE_TEMPLATE/` (bug, idea, config), `.github/pull_request_template.md` | **Added**. The bug form warns against pasting `zsk_…` tokens; the config links private security reports and the FAQ. Labels `bug` and `enhancement` already exist.                                                                                                                                                             |
| `.github/workflows/ci.yml`                                                        | **Hardened**: `permissions: contents: read`, since fork pull requests will run it.                                                                                                                                                                                                                                             |
| `.github/workflows/deploy-staging.yml`                                            | Checked: runs only on `workflow_run` of a **push** to `main` (or by hand), so a fork's pull request never reaches the Cloudflare secrets.                                                                                                                                                                                      |
| `.github/workflows/release-cli.yml`                                               | **Added**: publishes `zerosnake` from a `cli-v*` tag with npm trusted publishing (OIDC) and provenance. No secret.                                                                                                                                                                                                             |

## npm package `zerosnake`

- **Name**: `npm view zerosnake` → 404, free. `zero-snake`, `zero_snake`, `zerosnake-cli` and
  `@zerosnake/cli` are free too, so npm's similar-name rule shouldn't block it. The `@zerosnake`
  scope is unclaimed: claim it (checklist) so nobody else can publish `@zerosnake/sdk` and friends,
  which the CLI's own `package.json` lists as (never installed) devDependencies.
- **`packages/cli/package.json`**: `private` removed, `0.1.0`, MIT, `author`, `homepage`
  (`https://zerosnake.dev`), `bugs`, `repository` (with `directory`), keywords,
  `publishConfig.access: public`, `engines.node: >=24`, `files: [bin, dist]` (npm adds
  `README.md`, `LICENSE`, `package.json`). `provenance` is not in `publishConfig` because a local
  `npm publish` would fail with it; the release workflow passes `--provenance`.
- **QuickJS pinned exactly** (`0.32.0`, what the lockfile already resolved): npm users don't get
  the lockfile, and the op budget comes from QuickJS, so a patch release could change a local
  verdict. esbuild was already pinned for the same reason.
- **README**: user-facing quick start on top, then the existing internals.
- **Checked**: `pnpm --filter zerosnake build`, `npm pack --dry-run` (30 files, 352 kB packed,
  1.3 MB unpacked: `bin/`, `dist/cli.js`, `dist/client.js`, `dist/house/*`, `dist/sdk/`,
  `dist/template/`, no source maps, no local paths). Then `pnpm pack` and, in an empty folder
  outside the repo, `npm install ./zerosnake-0.1.0.tgz`, `npx zerosnake --version` (0.1.0),
  `npx zerosnake init my-snake`, `npx zerosnake sim --headless --seed 1` (my-snake 1243, first)
  and `npx zerosnake test` (passes, "Ready to deploy"); also
  `npx --package=./zerosnake-0.1.0.tgz zerosnake init` with nothing installed. npm 12 blocks
  esbuild's `postinstall` by default; the CLI works without it.
- **`DEFAULT_URL`** (the server the CLI talks to) is baked into `dist/cli.js` at publish time and
  can't change for that version. After #91 it is `https://zerosnake.dev`, checked in the built
  bundle. That host must answer before publishing (the checklist's hard gate in step 2).
