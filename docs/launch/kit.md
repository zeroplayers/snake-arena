# Launch kit

Copy for Product Hunt, Show HN, Reddit and X, and the launch-day checklist. Findings behind it:
[review.md](review.md).

**Assumptions.** On launch day both flags in `apps/web/src/site.ts` are flipped (`REPO.public =
true`, `CLI_PUBLISHED = true`), `zerosnake` is on npm, and the repository is public. `<SITE>`
stands for the launch domain (today `https://arena.surninsynergy.dev`), `<REPO>` for
`https://github.com/zeroplayers/snake-arena`. Numbers quoted below come from the docs and the
code; re-check anything marked _(check)_ on the day.
The text blocks are wrapped at 100 characters for this file: join each paragraph into one line
before pasting where line breaks survive (Product Hunt, X).

## Product Hunt

**Name:** ZeroSnake Arena

**Tagline** (≤ 60 characters; pick one):

1. `Your snake bot vs. everyone else's, live 24/7` (45) — matches the site's H1. Recommended.
2. `Vibe-code a snake bot with AI. Watch it fight 24/7.` (51) — the PH/X crowd's word.
3. `slither.io-style arena where every snake is code` (48)

**Description** (≤ 260 characters, 255):

```text
Describe a strategy to Claude, Cursor or any agent, or write it yourself: a bot is one
TypeScript function. npx zerosnake deploy puts it in an arena that never closes, where it
plays everyone else's bots, earns a rating and leaves a replay of every death.
```

**Topics:** Developer Tools, Artificial Intelligence, Games, Open Source.

**Thumbnail:** a short GIF (≤ 3 MB) of the hero: one snake coiling around another on the neon
disc. Motion beats a logo in the feed.

**First maker comment** (~200 words):

```text
Hi Product Hunt! I'm Oleksii.

I wanted a game where the fun part is the code, and where "vibe coding" gets a scoreboard.
ZeroSnake Arena is a slither.io-style arena where every snake is a program.

How it works:

1. `npx zerosnake init my-snake` gives you a starter bot plus CLAUDE.md, AGENTS.md and skills,
   so Claude Code, Cursor or Codex already know the rules and the API. Or write it by hand: a
   bot is one `tick()` function, state in, a turn out.
2. Tell your agent a strategy ("hunt snakes smaller than you, run from bigger ones") and
   `npx zerosnake sim` shows it against the house bots in your browser.
3. `npx zerosnake deploy`. It joins rooms that run around the clock, earns a rating, and every
   death leaves a replay and a trace of what your bot saw and did, so you (or Claude) can fix it.

No server to host: bots run in a metered QuickJS sandbox inside the arena. It's free, and
everything (engine, sandbox, CLI, site) is MIT on GitHub.

Fastest start: the "Copy prompt for Claude" button on the site. Paste it into Claude Code in an
empty folder and it does all of the above with you, including the GitHub sign-in.

The starter bot already beats the easiest house bot, so it can be in the arena tonight. What
strategy would you prompt first?
```

**Gallery** (1270×760; image 1 is also the social card):

1. The arena mid-fight, full bleed, with "Your snake bot vs. everyone else's."
   _Caption: A slither.io-style arena where every snake is a program._
2. Three panels: a prompt in Claude Code ("make it hunt smaller snakes") → the `tick()` it wrote
   → `npx zerosnake test` passing. Use real output from a real session.
   _Caption: One prompt, one bot, one command._
3. A terminal running `npx zerosnake deploy` next to the bot's page with its rating.
   _Caption: Deploy in one command. Ranked after 30 lives._
4. A replay frame with the trace panel open at the tick before a death.
   _Caption: Recent deaths explained: what your bot saw, what it returned, what killed it._
5. The project in an editor: `CLAUDE.md`, `AGENTS.md`, `.claude/skills/` and `src/bot.ts`.
   _Caption: Ships with the rules, the API and skills your agent already understands._

Optional 40–60 s video, no talking head: prompt typed (5 s) → `bot.ts` written (5 s) →
`zerosnake sim` viewer (10 s) → `deploy` (5 s) → the bot in the live arena and on the
leaderboard (10 s) → a death trace (10 s) → end card with `<SITE>`.

## Show HN

**Title** (≤ 80 characters):

`Show HN: ZeroSnake Arena – JS snake bots in a QuickJS sandbox, playing 24/7` (75)

Keep "vibe" and "Claude" out of the title. The link goes to `<SITE>`; post from your personal
account.

**First comment** (~240 words):

```text
Hi HN. ZeroSnake Arena is a game for programs: you write a snake bot in JS/TS (one `tick()`
function: state in, `{ turn, boost }` out), upload it with `npx zerosnake deploy`, and it plays
other people's bots in rooms that never close. The rules are slither.io-like: continuous
movement, limited turning, boosting costs length. `npx zerosnake init` and `sim` run locally
with no account; only `deploy` needs a GitHub sign-in.

The parts that were fun to build:

- The engine is deterministic TypeScript with a seeded RNG and its own trig. A replay is the
  seed plus every bot's actions; `zerosnake sim --seed N` reproduces a match locally.
- Workers can't `eval`, so each bot runs in its own QuickJS context compiled to wasm (8 MiB
  per bot). The same sandbox package runs in the CLI, the deploy checks and the arena.
- The tick budget isn't wall-clock: bundles are instrumented to charge per statement, and
  built-ins are charged by input size, so a bot that fits on your laptop fits on the server.
- Each room is a Durable Object that simulates in batches, faster than real time unless
  someone is watching.
- Rating is the mean of a version's last 200 lives, ranked by the lower bound of its interval,
  so redeploying until you get lucky doesn't help.

The template ships a CLAUDE.md because that's how I iterate on bots, but Claude is optional;
it's plain TypeScript.

Known weak spots: bots in one room share a wasm heap, so a QuickJS memory bug could let a bot
reach its roommates (not other rooms or the database), and ratings need a few hundred lives to
settle.

MIT, source: `<REPO>`. Happy to go deep on the sandbox or the metering.
```

**Prepared answers** to the comments the HN reviewer expects (adapt, don't paste):

- _"So it's Battlesnake / Screeps?"_ Close relatives. The difference: your bot isn't a server
  you host and nobody calls it over HTTP. You upload code and it runs inside the arena in a
  metered sandbox, so there's no hosting and no latency, every match replays exactly from its
  seed, and movement is continuous rather than a grid.
- _"Running strangers' JS on Cloudflare?"_ Bot code never runs in V8: it runs in QuickJS
  compiled to WebAssembly, with no host functions except `log()`, no I/O, no clock, no imports.
  CPU is bounded per tick by instrumented op counting (10 M cost units, ~10 ms), and a `while
  (true)` dies after 3 ticks. The honest weak spot is the shared wasm heap per room (above).
- _"Do I need Claude? Is this an Anthropic ad?"_ No and no. A bot is one plain TS file; the
  template includes CLAUDE.md and AGENTS.md because coding agents are good at this loop. Not
  affiliated with Anthropic.
- _"If Claude writes it, who's playing?"_ You choose the strategy: when to boost, when to hunt,
  how much risk near a bigger snake. The arena gives you the loop (traces, exact local replays, a
  rating with an interval). The starter bot clears the entry bar; above it, strategy separates
  bots, not who typed them.
- _"Empty leaderboard?"_ Only if you skip the soft open (checklist below).
- _"Who's behind it / business model / what if it shuts down?"_ _(owner to decide)_: who pays,
  whether there will be a paid tier, and that everything is MIT and runs locally: `pnpm dev` in
  `apps/web` serves the site on workerd and `pnpm dev` in `apps/arena` runs the arena worker
  (`wrangler dev`), sharing local D1/R2 state (see `apps/web/README.md`); your bot lives in your
  own repo.
- _"Is this affiliated with slither.io?"_ No. The mechanics are inspired by it; the engine,
  rules and graphics are our own (the renderer comes from our earlier ZeroSnake game).
- _"Node 24 only?"_ It's an LTS line and the CLI uses its built-ins _(check whether 22
  works; the DX run says `init` and `sim` did)_.

## Reddit

Read each subreddit's self-promotion rules first; post from a personal account that comments
there, answer every reply, and space the posts out (not all on one day). Lead with the technical
story on r/programming and r/javascript; lead with the AI angle only in AI communities.

**r/javascript or r/programming** (link or text post, depending on the sub's rules):

Title: `I built an arena where TypeScript snake bots play each other 24/7, sandboxed in QuickJS on Cloudflare (MIT)`

```text
ZeroSnake Arena is a slither.io-style game where every snake is a program. A bot is one
`tick()` function: each tick it gets what its snake sees (food and snakes within 40 units, the
distance to the wall) and returns how much to turn and whether to boost.

`npx zerosnake init my-snake` gives you a starter bot, `npx zerosnake sim` plays it against the
house bots in your browser, and `npx zerosnake deploy` uploads it. There's no server to host:
the arena runs it in a QuickJS sandbox compiled to wasm, inside a Cloudflare Durable Object per
room, with a per-tick budget counted in instrumented cost units (so it's the same on your laptop
and on the server). The engine is deterministic, so local matches replay exactly from a seed.

Bots are rated over their last 200 lives and ranked by the low end of the interval. Every
death leaves a replay and a trace of the last ticks: what your bot saw and returned.

You can write the bot by hand, or with Claude Code / Cursor (the template ships CLAUDE.md,
AGENTS.md and skills).

Site: `<SITE>` · Source (MIT): `<REPO>`. Feedback on the sandbox and the rules very welcome.
```

**r/gamedev:** title `A zero-player game: players write the snake AI, then watch it play everyone else's`, and
lead with the game design: the rules, why continuous movement, how the rating copes with luck,
the spectator view. **AI communities** (r/ClaudeAI, r/singularity-style subs): title `I made an
arena where AI-written snake bots fight 24/7, and the leaderboard is open`, lead with the prompt
→ bot → rank loop and a GIF.

## X thread

1/ Your snake bot vs. everyone else's.

ZeroSnake Arena: a slither.io-style arena where every snake is a program. You vibe-code it with
Claude (or Cursor, or by hand), deploy with one command, and it fights 24/7.

`<SITE>` 🧵 _(attach the hero GIF)_

2/ A bot is one function. Every tick it sees food and snakes around its head and returns how
much to turn and whether to boost. That's the whole API. The strategy is yours. _(code
screenshot)_

3/ `npx zerosnake init my-snake` gives you a starter bot plus CLAUDE.md, AGENTS.md and skills,
so your agent already knows the rules.

Then: "make it hunt snakes smaller than it". `npx zerosnake sim` shows the result in your
browser. Or press "Copy prompt for Claude" on the site and let Claude Code do the whole setup.
_(sim viewer screenshot)_

4/ `npx zerosnake deploy`: the same checks as the server run locally, then the bot joins rooms
that never close. No server to host. _(terminal screenshot)_

5/ Recent deaths come with a replay and a trace of what your bot saw and returned in its last ticks.
Hand it to Claude, ship v2, watch the rating move. _(trace screenshot)_

6/ Under the hood: deterministic TS engine, each bot in its own QuickJS-in-wasm sandbox with a
metered tick budget, one Cloudflare Durable Object per room. Rated by the low end of its
interval, so luck doesn't top the board.

7/ It's free and MIT: engine, sandbox, CLI and the site. `<REPO>`

The starter bot already beats the easiest house bot. Who's first on the leaderboard? 🐍

## Launch-day checklist

**A week before (soft open)**

- [ ] Final domain live; `SITE_URL` (`apps/web/src/site.ts`), `DEFAULT_URL`
  (`packages/cli/src/remote/config.ts`), `robots.txt`, `sitemap.xml` and the README updated.
- [ ] `zerosnake` and the `@zerosnake` org claimed on npm; `packages/cli` made publishable
  (review.md, "Needs the owner" 1) and published; `npx zerosnake init` tested from an empty
  cache on macOS, Linux and Windows/WSL.
- [ ] Decide what `init` does about the template's `npm test` (review.md, "Needs the owner" 4).
- [ ] Flip `REPO.public` and `CLI_PUBLISHED`, make the repo public, deploy. Check: no "Coming at
  launch", no "Not on npm yet", GitHub links work, "Copy first steps" copies one line.
- [ ] Paste the "Copy prompt for Claude" prompt into Claude Code in an empty folder with the
  published CLI and follow it to a deployed bot. Fix the prompt (`claudePrompt.ts`) if any step
  stumbles. Try the button on an iPhone and an Android phone.
- [ ] Invite 30–50 people; target 15–25 bots from 10+ authors past 30 lives before launch.
- [ ] Production GitHub OAuth app (homepage and callback on the final domain), secrets set.
- [ ] Footer "Made by …" and FAQ "About the project" (who pays, self-hosting, fair play) written.

**The day before**

- [ ] A showcase room is live: the hero caption reads "Live from the arena".
- [ ] Leaderboard has rows; a few bot pages have replays with traces worth showing.
- [ ] Preview cards checked on the final URL: X card validator / a test post, LinkedIn Post
  Inspector, Facebook Sharing Debugger, Discord, Slack (`og.jpg` shows, title and
  description right).
- [ ] Gallery images, thumbnail GIF and video exported; PH draft scheduled for 00:01 PT.
- [ ] Rate limits and daily quotas (20 deploys per author, 100 lives per bot) reviewed for a
  traffic spike; dashboards and alerts open (`apps/web/README.md` "Operations").
- [ ] Lighthouse on the final URL (phone): no regressions from review.md's numbers.

**Launch day**

- [ ] PH at 00:01 PT; first maker comment posted right away; answer every comment for the first
  6 hours.
- [ ] Never ask anyone to upvote or comment, or post direct links to the HN/PH pages asking for
  support: both sites treat it as vote-ringing and bury or penalize the post. Share the site
  link; people find the threads.
- [ ] X thread once the PH page is live; pin it.
- [ ] Show HN on a different day from PH (before or after), mid-morning US Eastern, from the
  personal account, with the first comment above posted immediately.
- [ ] Reddit posts spread over the week, one subreddit at a time, following each sub's rules.
- [ ] Watch: deploy errors, check-queue backlog, room count, the showcase, CPU per tick, error
  logs. Fix-forward only what blocks people; note the rest as issues.

**After**

- [ ] Reply to every issue opened that week; thank the first bots publicly (with permission).
- [ ] Post a "week one" follow-up: number of bots and authors, the top strategy, the funniest
  death replay.
