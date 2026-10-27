# Launch review: landing page and public site

Review of <https://arena.surninsynergy.dev> (staging, `main` @ `d8071c1`) and its sources before
the launch on Product Hunt, Show HN, Reddit and X. Done on 2026-10-27.

**Method.** Nine independent reviewers each got the same brief, the staging screenshots
(1440×900 and 375×812) and the code paths, and were told to be harsh and give exact copy or code:

| Reviewer                               | Focus                                                            |
| -------------------------------------- | ---------------------------------------------------------------- |
| Product Hunt hunter                    | the first 10 seconds, day-one traction, gallery, taglines        |
| Growth marketer                        | positioning, the hook, the 5-second test, CTA hierarchy          |
| Conversion copywriter                  | every line of copy, headline options per audience                |
| User A: vibe-coder, never wrote a bot  | the journey from X to a first win; ran `init` and `sim`          |
| User B: Battlecode / Screeps veteran   | rules, limits, rating soundness, exploits, skill ceiling         |
| HN skeptic                             | the likely Show HN thread and how to defuse it                   |
| Visual / UI designer                   | hierarchy, type, colour, spacing, mobile                         |
| Accessibility, performance, SEO/social | Lighthouse, meta and preview cards, icons, caching               |
| Onboarding / DX                        | followed the quick start literally (checkout, `npm pack`, `npx`) |

What they agreed on, nearly unanimously: the page and the docs said the product doesn't work, a
shared link had no preview, and the hero sold a workflow rather than a reason to care. The live
arena itself was everyone's favourite thing on the page.

Before/after screenshots are in [`screenshots/`](screenshots).

Status: **done** = changed in this PR; **owner** = needs a decision or an action outside the code
(accounts, ops, money); **later** = a proposal, deferred with the reason given.

## Top findings, ranked by launch impact

| #   | Finding                                                                                                                                                                                                                          | Raised by              | Status                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------- |
| 1   | The landing's "Before launch" box would still say on launch day that `test` "is being wired in" and `deploy` "waits in validation" (only the `npx` row was tied to `CLI_PUBLISHED`).                                             | all 9                  | done                                           |
| 2   | The docs opened with "no bot plays in the arena yet", a status table of PRs "in review" and boxes saying `login`/`deploy` aren't available, although everything is merged. `limits.md` described the pre-#62 budget.             | 8 of 9                 | done                                           |
| 3   | No link preview: no `og:*` / `twitter:*` tags, no image. Every share on X, Reddit, Slack, Discord, PH would be a bare link.                                                                                                      | 8 of 9                 | done (og.jpg, tags)                            |
| 4   | A new user's first `npx zerosnake deploy` failed: it needed `--create`, which only the CLI README mentioned, and the error said "deploy to one of them" with an empty list.                                                      | DX                     | done (CLI)                                     |
| 5   | Day one is a ghost town: empty leaderboard (30 lives to rank), the hero says "simulated in your browser", no proof anyone uses it.                                                                                               | 7 of 9                 | owner (seed bots, live room); empty state done |
| 6   | The `zerosnake` npm name is unclaimed (`npm view zerosnake` → 404), and `packages/cli` is `private`, 0.0.0, with no license/repository fields. Someone else can register it before launch.                                       | DX                     | owner, urgent                                  |
| 7   | The H1 described a workflow ("Vibe-code… Deploy… Watch…"), repeated by How it works; the competitive hook was missing; "with Claude" read as Claude-only (and as an Anthropic ad on HN) although the template ships `AGENTS.md`. | 6 of 9                 | done                                           |
| 8   | On phones the first screen had no call to action (header on two rows, 4-line H1, full-width arena, CTA below the fold).                                                                                                          | designer, growth, copy | done                                           |
| 9   | The brightest element was the green "Sign in with GitHub" pill, a dead end for a new visitor (deploying happens in the CLI, whose `login` does the same).                                                                        | 4 of 9                 | done (ghost, "Sign in" on phones)              |
| 10  | The page never showed what a bot is, or the facts a serious bot author needs (determinism, budget, memory, rating). HN's "under the hood" depth was buried in package READMEs.                                                   | user A, user B, HN     | done (new section, README)                     |
| 11  | The repo README (the second landing page once the repo is public) was an ops runbook: staging secrets, wrangler commands, "v0 in progress".                                                                                      | PH, HN, DX             | done                                           |
| 12  | The Silom font ships only with macOS. Windows, Linux, Android and iOS visitors saw every paragraph in a fallback monospace; long text in the display face is hard to read anyway.                                                | designer, a11y         | done (body in system UI); brand webfont later  |
| 13  | "Start in a minute" over seven commands invites a dunk; the copy button would paste a script that can't run (npx's prompt eats the next line; `sim` blocks).                                                                     | copy, PH, user A, DX   | done                                           |
| 14  | Leaderboard sorts by a column it doesn't show (mean − interval), so "80 ± 45" below "60 ± 5" looks like a bug; "95%" contradicts rating.md's own coverage numbers.                                                               | user B                 | done                                           |
| 15  | Missing `favicon.ico`, apple-touch icon, manifest, robots rules, sitemap, canonical URLs, per-page descriptions; hashed assets served with `max-age=0`.                                                                          | a11y/SEO               | done                                           |

## Done in this PR

**Landing** ([`Landing.tsx`](../../apps/web/src/components/landing/Landing.tsx),
[`quickstart.ts`](../../apps/web/src/components/landing/quickstart.ts),
[`ArenaHero.tsx`](../../apps/web/src/components/landing/ArenaHero.tsx), `app.css`)

- Eyebrow "zeroplayers · zero-player games" → "Programming game · JS/TS · open source soon"
  ("open source, MIT" once `REPO.public`). The brand stays in the footer.
- H1 → "Your snake bot vs. **everyone else's.**" (the competitive hook, 6 words, no tool named).
  Lead → "A slither.io-style arena where every snake is a program. Describe a strategy to Claude
  Code, Cursor or any coding agent, or write the TypeScript yourself. `npx zerosnake deploy` puts
  it in rooms that run around the clock, with no server for you to host. It earns a rating, and
  every death leaves a replay of what killed it." This answers "is it Claude-only", "do I host
  it" (the Battlesnake comparison) and "why come back", and says "slither.io-style" rather than
  "is slither.io".
- CTAs: "Build your bot" (→ `#start`) and "Read the docs". The hero's Leaderboard button is gone
  (it's in the nav, and empty on day one). On phones the buttons sit between the H1 and the
  arena, so the first screen has an action.
- How it works: "Write it" / "Ship it" / "Watch it, fix it". Names other agents and hand-coding,
  says the checks are the same as the server's, that there's nothing to host, that sources are
  public, defines a "life", and sells death traces (the retention loop). Steps are no longer
  three boxed cards.
- New section "Your bot is one function": what `tick()` sees and returns, the starter bot's code,
  and "For serious bot authors": deterministic, metered not timed (10 ms, 8 MiB, 256 KiB, no
  I/O), ranked by evidence, Claude optional; links to Rules, Bot API, Limits, Rating, FAQ.
- Quick start "From zero to the arena", in two parts: "Try it on your machine (no account)"
  (`init my-snake`, `cd`, `sim`, `claude`) and "Put it in the arena" (`test`, `login`,
  `deploy`). Drops `npm install` (optional, editor types only); uses `my-snake` like the docs.
  The note says it's free, Node 24+, what needs an account, and that the starter already beats
  `easy`. "Copy first steps" copies one line, `npx zerosnake init my-snake && cd my-snake && npx
  zerosnake sim`. On phones each comment sits above its command.
- The not-yet box only has the `npx` row ("Not on npm yet"), so it disappears when
  `CLI_PUBLISHED` flips. A test now asserts that.
- Hero caption "House bots, simulated live in your browser" → "Demo: house bots on the real
  engine, in your browser"; stage `aria-label` says live or demo; Pause has `aria-pressed` and
  a label. The warm-up runs in 8 ms slices (Lighthouse saw 65–240 ms long tasks from 50-tick
  slices).
- "Go deeper" → "More", with clearer card copy.

**Site-wide** (`__root.tsx`, `lib/meta.ts`, `site.ts`, `app.css`, `public/`)

- `siteMeta()`: title "ZeroSnake Arena: your snake bot vs. everyone else's", a 161-character
  description, Open Graph and Twitter `summary_large_image` tags with `public/og.jpg`
  (1200×630, 200 KB, a real arena frame plus the H1; source and regeneration command in
  [`apps/web/og/og.html`](../../apps/web/og/og.html)). `SITE_URL` in `site.ts` makes the image
  URL absolute: **change it with the launch domain**.
- `pageMeta()` / `canonical()`: per-page titles, descriptions (each docs page has its own),
  `og:url` and `rel=canonical` on public pages; `noindex` on settings, bots, welcome and device.
- `favicon.ico`, `apple-touch-icon.png`, 192/512 icons, `site.webmanifest`, `robots.txt`,
  `sitemap.xml`, and `_headers` with `immutable` caching for `/assets/*`.
- Header: "Sign in with GitHub" is a ghost button ("Sign in" on phones); the header fits one row
  at 375 px; a GitHub link appears in the nav once `REPO.public`. Skip link, visible focus
  rings (`:focus-visible`, inputs too).
- Running text uses the system UI font (headings, nav and buttons keep Silom where installed,
  with a sans fallback instead of monospace). Primary buttons are full green with a glow; the
  arena gets a soft glow and more width on desktop; more space between sections.
- Footer: "ZeroSnake Arena is a zeroplayers game: code plays, people watch." with Rules,
  Leaderboard, Docs, GitHub.
- 404: "Nothing here", a hint for bot links, Home and Leaderboard buttons.

**Leaderboard** ([`leaderboard.tsx`](../../apps/web/src/routes/leaderboard.tsx)): plain-language
intro first ("Ranked by the low end of each bot's rating…", "a nominal 95% interval"), a link to
Rating, a "Ranked by" column (rating − interval, the sort key; hidden on phones), and an empty
state that says why it's empty and links to the quick start.

**Docs**: removed every "in review" box, the status table and "no bot plays in the arena yet"
(`README.md`, `getting-started.md`, `limits.md`, `rating.md`, `faq.md`, `bot-api.md`).
`limits.md` describes the merged #62 budget (10 000 000 cost units, interrupts as a second limit,
the instrumentation's load-time rejections, the checks-only half-budget cap). `rating.md` says
how rooms are really filled (FIFO plus house fill, not random) and to treat overlapping ranges
as noise. `getting-started.md` opens with "What you need" (Node 24, free, which steps need an
account, Claude optional) and says plainly that the template's `npm test` / `bench` need
unpublished packages. The FAQ and Bot API now say honestly that house bots are recognisable in
rooms (`house:<kind>`) but disguised in the checks.

**CLI** (small, because the landing advertises it): an author's first `deploy` creates the bot
without `--create`; later bots still need it, so a typo can't start a new bot. Help: "Docs:
https://arena.surninsynergy.dev/docs" instead of the private repo, and "Coming soon: replays"
replaced by where replays are.

**README**: product first (pitch, quick start, how it works: engine, sandbox, arena, rating,
site), then Development, then Operations (unchanged content). "Status: v0 in progress" dropped.

## Needs the owner (not code in this PR)

Ordered by how badly launch day goes without them.

1. **Claim the npm names now.** `zerosnake` is unregistered; create the `@zerosnake` org too.
   Then make `packages/cli` publishable: drop `"private": true`, version `0.1.0`, `license`,
   `repository`, `homepage`, `keywords`, LICENSE in `files`; publish with `pnpm publish` (it
   rewrites `workspace:*`). The DX reviewer packed the CLI and ran `npx <tgz> init/test/sim`
   from an empty cache: it's self-contained and works.
2. **Don't launch to an empty arena.** Soft-open (flip `REPO.public` and `CLI_PUBLISHED`) 5–7
   days before PH; get 15–25 bots from 10+ authors past 30 lives; keep a showcase room live
   during launch week so the hero says "Live from the arena". Run Show HN and PH on different
   days.
3. **Pick the launch domain** before anything is posted (links are permanent; `surninsynergy.dev`
   reads as a personal staging host). Then change `SITE_URL` (`apps/web/src/site.ts`),
   `DEFAULT_URL` (`packages/cli/src/remote/config.ts`), `robots.txt`, `sitemap.xml` and the
   README.
4. **The template's `npm test` / `npm run bench` / `npm run typecheck` fail in a project made by
   `init`** (they need `@zerosnake/engine`, `sandbox`, `house-bots`, unpublished and raw
   TypeScript), and `init` prints "Not on npm yet…". Either build and publish those packages, or
   make `init` drop `test/` and point the scripts at `zerosnake sim` / `zerosnake test` (and add
   `zerosnake` as a devDependency so the CLI version, and with it the bundle, is pinned). The
   `debug-death` and `new-strategy` skills use `npm run bench`, so this decides their wording
   too. Docs now say so honestly; this needs a decision.
5. **Say who's behind it.** HN's "who is this, and why should I give an anonymous site GitHub
   OAuth" is predictable. A "Made by …" line in the footer and posting from a personal account
   fix it. Left out here because it's a personal choice.
6. **Cost and longevity answer**: decide what to say about who pays, a paid tier (SPEC mentions
   paid quotas), and what happens if it shuts down. Draft answers are in the kit.
7. **Fair-play policy**: one person, one account; no teaming across accounts (bots can recognise
   each other by `author` id); no unchanged copies of another author's public bot. Needs your
   wording before it goes in the FAQ.
8. **Seasons / rule changes**: "the numbers may still be tuned" on a live ladder needs a policy
   (announce changes, reset the board as a new season). Decide before launch.
9. Make sure the staging GitHub OAuth app and secrets are what production uses, and run the
   preview cards through the X, LinkedIn and Facebook debuggers on the final URL.

## Deferred proposals

**Out of scope here** (other sessions are changing these areas):

- _Renderer / arena shape_ (square-arena, remains-size): name labels over snakes (the "my bot is
  there" moment); a poster frame behind the canvas so phones don't show a black box while three.js
  loads (do it after the square arena lands, or the poster will show the old round one); regenerate
  `og.jpg` from the new arena (`apps/web/og/`); `antialias` and pixel ratio on phones.
- _Replay page_ (replay-retention): a Share button; per-replay `og:title` ("viper died to …");
  canonical and description.
- _Rules / engine_ (owner decisions, raised by the Battlecode veteran): a fresh `author` token
  per room (stops cross-account teaming by id) and disguising house bots in rooms as the checks
  do; spawn protection or a kill bonus scaled by victim mass (spawn camping: a mass-10 snake is
  worth 50 points); a server-side salt for check seeds (a bot can grind seeds locally until it
  qualifies); an engine version stamped in replays; `hard` scores below `medium` in full rooms
  (packages/rating README, finding 5): rename the bots by style or retune `hard`.

**Later, worth doing:**

- Self-host an open-licence display font (e.g. Oxanium, ~30 KB woff2) so the brand looks the same
  everywhere, and regenerate the OG image with it. A brand decision.
- Show house bots as greyed "baseline" rows on the leaderboard so it's never empty and shows the
  bar (needs their room ratings, which the rating job doesn't record for house bots).
- Rank, a Share-on-X button and a README badge (`/badge/@user/bot.svg`) on bot pages: the share
  and retention loop.
- An in-browser playground (`/play`: edit a bot, run it against the house bots) or an "Open in
  Codespaces" template: a way to try it from the PH page without Node 24. Large.
- `?ref=producthunt` banner and the PH badge during launch week.
- `docs/architecture.md` ("under the hood": engine, sandbox, metering, rooms, measured cost per
  tick) linked from the docs index and the landing, plus a threat-model paragraph in
  `limits.md` (QuickJS in wasm, no host functions; bots of one room share a wasm heap) and a
  `SECURITY.md`. The README now has a short version.
- FAQ "About the project": prior art (Battlesnake, Screeps), do I need Claude, affiliation with
  slither.io or Anthropic, who pays, can I self-host. Drafts are in the kit's prepared answers.
- `SPEC.md` §9 cost numbers are flagged "from memory, need checking" in a file that becomes
  public; replace with measured numbers from the arena metrics or remove.
- The live-showcase proxy answers 503 when no room is live, so every landing visit logs a red
  WebSocket error in DevTools (Lighthouse Best Practices 96). Accept the upgrade and close with a
  reason instead (`apps/web/src/server/showcase.ts`); check `BroadcastSource` doesn't then retry
  in a loop.
- Load the better-auth client on click instead of in every page's entry bundle (~40 KB unused);
  check whether root `beforeLoad`'s `getViewer()` adds a round trip to every client navigation.
- Rule-change notice in `rules.md`, fair-play section in the FAQ (wording above).
- CLI polish from the DX run: hints say bare `zerosnake …` (not on PATH; should be `npx
  zerosnake`); `init`'s "Next" stops before `test`/`deploy`; the "checks took 20 s, may be
  rejected" warning measures wall-clock time and fired for the starter bot on a busy laptop
  (use CPU time or the report's deterministic cost); the test report says "budget 10 ops per
  tick"; a Node < 24 check in `bin/zerosnake.js` (the CLI ran on Node 22, so maybe relax
  `engines` instead).
- Template: the `new-strategy` skill measures a 20-seed baseline before writing any code (about
  7 minutes of sims); a 5-seed quick baseline would give a first-timer a result sooner.
  `template/README.md` says "the arena is a circle": sync with the square-arena change.

## Considered and not done

- **Neutral borders instead of violet everywhere** (designer). The violet is the original
  ZeroSnake look and passes contrast (3.1:1); the PR reduces card overuse instead.
- **Keeping "vibe-code" in the H1** (PH reviewer). It's the hook on X and PH but costs credibility
  on HN and r/programming; the kit uses it in X and PH copy, the page doesn't.
- **"Slither.io, but every snake is a program." as the H1** (copywriter). Strong, but uses a
  trademark as the product's identity (HN reviewer); kept as "slither.io-style" in the lead.
- **A third "Source (MIT)" hero button.** Three pills wrap on phones; GitHub goes in the header
  and the More section once the repo is public.

## Measurements

- Lighthouse 12.8.2 on staging before (mobile, simulated): `/` Performance 83, Accessibility 100,
  Best Practices 96 (the WebSocket 503), SEO 100; LCP 1.2 s (the H1), CLS 0, TBT 340 ms
  (hero warm-up). `/leaderboard` 100 performance; `/docs/getting-started` 91.
- Contrast against `#080808`: muted text 8.6:1, lead 7.4:1, links and buttons ≥ 9.8:1, violet
  borders 3.1:1 (don't darken them).
- DX run: `init` 0.2 s; `zerosnake test` on the starter: passes, 130.6 vs `easy`'s 32.4, 4.8 s
  of CPU; `sim --no-open` serves the viewer in ~2.5 s; `npx` of the packed CLI from an empty
  cache works.
