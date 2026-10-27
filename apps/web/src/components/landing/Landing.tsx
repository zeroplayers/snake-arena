import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { CLI_PUBLISHED, REPO } from "../../site";
import { GithubLink } from "../GithubLink";
import { ArenaHero } from "./ArenaHero";
import { ClaudePromptBlock, CopyPromptButton } from "./ClaudeStart";
import { claudePromptWorks } from "./claudePrompt";
import { NOT_YET, QUICKSTART, quickstartScript } from "./quickstart";

const HOW = [
  {
    title: "Write it",
    body: (
      <>
        Tell Claude Code, Cursor or any coding agent what kind of snake you want, or write it
        yourself. The project template gives the agent the rules, the bot API and skills for trying
        strategies and debugging deaths. <code className="code-accent">npx zerosnake sim</code>{" "}
        plays it against the house bots in your browser.
      </>
    ),
  },
  {
    title: "Ship it",
    body: (
      <>
        <code className="code-accent">npx zerosnake deploy</code> runs the checks the server runs:
        the bot loads, stays within its budget and beats the easiest house bot. Then the arena runs
        it in a sandbox, so there's no server for you to host. Every version's source is public on
        its bot page.
      </>
    ),
  },
  {
    title: "Watch it, fix it",
    body: (
      <>
        Rooms run around the clock. Each spawn-to-death is a life with a score, and after 30 lives
        your bot is ranked. Every life has a replay, and every death a trace of what your bot saw
        and did, so you (or Claude) can fix it and ship v2.
      </>
    ),
  },
] as const;

/** The starter bot, trimmed: what a bot is, at a glance. */
const BOT_SNIPPET = `import { defineBot, nearestDanger, nearestFood,
  steerAway, steerToward } from "@zerosnake/sdk";

export default defineBot({
  tick(state) {
    const danger = nearestDanger(state);
    if (danger && danger.gap < 5)
      return { turn: steerAway(state.self, danger.point) };
    const food = nearestFood(state);
    if (!food) return { turn: 0 };
    return { turn: steerToward(state.self, food) };
  },
});`;

const FACTS = [
  {
    title: "Deterministic",
    body: "A seeded engine with its own math: the same seed and the same bots give the same match, every time, so any local match can be replayed from its seed.",
  },
  {
    title: "Metered, not timed",
    body: "About 10 ms of CPU per tick, counted in cost units so it's the same on every machine. 8 MiB of memory, a 256 KiB bundle, no I/O, no clock.",
  },
  {
    title: "Ranked by evidence",
    body: "The mean score over a bot's last 200 lives, ranked by the low end of its range, so a lucky streak can't beat a steady record.",
  },
  {
    title: "Claude is optional",
    body: "The arena doesn't know who wrote the code. Every bot gets the same view and the same budget.",
  },
] as const;

const DOC_LINKS = [
  { slug: "rules", label: "Rules" },
  { slug: "bot-api", label: "Bot API" },
  { slug: "limits", label: "Limits" },
  { slug: "rating", label: "Rating" },
  { slug: "faq", label: "FAQ" },
] as const;

/** `/`: what ZeroSnake Arena is, a match to watch, and how to get a bot in. */
export function Landing({ signedIn, onSignIn }: { signedIn: boolean; onSignIn: () => void }) {
  return (
    <>
      <section className="landing-hero">
        <div className="landing-head">
          <p className="eyebrow">
            Programming game · JS/TS · {REPO.public ? "open source, MIT" : "open source soon"}
          </p>
          <h1 className="title landing-title">
            Your snake bot vs. <span className="accent">everyone else's.</span>
          </h1>
        </div>
        <div className="landing-cta">
          <div className="actions">
            {claudePromptWorks() ? (
              <CopyPromptButton className="button" />
            ) : (
              <a href="#claude" className="button">
                Start with Claude
              </a>
            )}
            <a href="#start" className="button ghost">
              Build it by hand
            </a>
          </div>
          <ol className="hero-steps">
            <li>
              <strong>Paste the prompt</strong> into Claude Code in an empty folder, or run{" "}
              <code>npx zerosnake init</code> yourself.
            </li>
            <li>
              <strong>Watch your snake</strong> play the house bots on your machine. No account
              needed.
            </li>
            <li>
              <strong>Deploy it:</strong> <code>zerosnake login</code> opens your browser to sign in
              with GitHub.
            </li>
          </ol>
        </div>
        <ArenaHero />
        <div className="landing-body">
          <p className="lead">
            A slither.io-style arena where every snake is a program. Describe a strategy to Claude
            Code, Cursor or any coding agent, or write the TypeScript yourself.{" "}
            <code>npx zerosnake deploy</code> puts it in rooms that run around the clock, with no
            server for you to host. It earns a rating, and every death leaves a replay of what
            killed it.
          </p>
        </div>
      </section>

      <section aria-labelledby="how" className="landing-section">
        <h2 id="how" className="subtitle">
          How it works
        </h2>
        <ol className="how">
          {HOW.map((step, i) => (
            <li key={step.title} className="how-step">
              <span className="how-n" aria-hidden="true">
                {i + 1}
              </span>
              <h3>{step.title}</h3>
              <p className="muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="bot" className="landing-section bot-section">
        <div>
          <h2 id="bot" className="subtitle">
            Your bot is one function
          </h2>
          <p className="muted">
            Every tick (10 a second of game time), <code className="code-accent">tick()</code> gets
            what your snake sees: food and other snakes within 40 units of its head, and how far the
            wall is. It returns how much to turn and whether to boost (double speed, paid for in
            length). That's the whole API; the strategy is yours.
          </p>
          <pre className="code-block">
            <code>{BOT_SNIPPET}</code>
          </pre>
        </div>
        <div>
          <h3 className="small eyebrow">For serious bot authors</h3>
          <dl className="facts-list">
            {FACTS.map((f) => (
              <div key={f.title}>
                <dt>{f.title}</dt>
                <dd className="muted">{f.body}</dd>
              </div>
            ))}
          </dl>
          <p className="small doc-links">
            {DOC_LINKS.map((d, i) => (
              <span key={d.slug}>
                {i > 0 && " · "}
                <Link to="/docs/$slug" params={{ slug: d.slug }}>
                  {d.label}
                </Link>
              </span>
            ))}
          </p>
        </div>
      </section>

      <section id="start" aria-labelledby="start-title" className="panel landing-section">
        <h2 id="start-title" className="subtitle">
          From zero to the arena
        </h2>
        <div id="claude" className="landing-section">
          <ClaudePromptBlock />
        </div>
        <div className="start-head by-hand">
          <h3 className="start-part-title">Or by hand</h3>
          {CLI_PUBLISHED ? (
            <CopyButton label="Copy first steps" text={quickstartScript()} />
          ) : (
            <span className="soon-tag">Coming at launch</span>
          )}
        </div>
        {QUICKSTART.map((part) => (
          <div key={part.title} className="start-part">
            <h3 className="small start-part-title">{part.title}</h3>
            <ol className="terminal">
              {part.commands.map(({ cmd, note }) => (
                <li key={cmd}>
                  <code>
                    <span className="prompt" aria-hidden="true">
                      ${" "}
                    </span>
                    {cmd}
                  </code>
                  {note && <span className="muted"># {note}</span>}
                </li>
              ))}
            </ol>
          </div>
        ))}
        <p className="muted small">
          Free. Needs Node.js 24+. Everything up to <code>test</code> runs on your machine with no
          account; GitHub sign-in is only for <code>login</code> and <code>deploy</code>. The
          starter bot already beats <code>easy</code>, the bar for entering the arena: your job is
          to beat the rest.{" "}
          <Link to="/docs/$slug" params={{ slug: "getting-started" }}>
            Getting started
          </Link>{" "}
          has every step and option.
        </p>
        {NOT_YET.length > 0 && (
          <div className="not-yet">
            <h3 className="small">Not on npm yet</h3>
            <ul>
              {NOT_YET.map((n) => (
                <li key={n.what}>
                  <code>{n.what}</code> {n.detail}
                </li>
              ))}
            </ul>
            {REPO.public && !CLI_PUBLISHED && (
              <p className="small muted">
                <Link
                  to="/docs/$slug"
                  params={{ slug: "getting-started" }}
                  hash="before-the-packages-are-published"
                >
                  Running the CLI from a checkout
                </Link>
              </p>
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="next" className="landing-section landing-links">
        <h2 id="next" className="subtitle">
          More
        </h2>
        <ul className="link-grid">
          <li>
            <Link to="/leaderboard" className="panel link-card">
              <strong>Leaderboard</strong>
              <span className="muted">
                Every bot with 30+ lives, ranked so a lucky streak can't beat a steady record.
              </span>
            </Link>
          </li>
          <li>
            <Link to="/docs" className="panel link-card">
              <strong>Docs</strong>
              <span className="muted">Rules, bot API, sandbox limits, rating and the FAQ.</span>
            </Link>
          </li>
          <li>
            <div className="panel link-card">
              <strong>
                <GithubLink />
              </strong>
              <span className="muted">
                {REPO.public
                  ? "Engine, sandbox, CLI, house bots and this site. MIT licensed."
                  : "Engine, sandbox, CLI, house bots and this site. Open source at launch."}
              </span>
            </div>
          </li>
          <li>
            {signedIn ? (
              <Link to="/bots" className="panel link-card">
                <strong>Your bots</strong>
                <span className="muted">Versions, check reports and deploys left today.</span>
              </Link>
            ) : (
              <button type="button" className="panel link-card" onClick={onSignIn}>
                <strong>Sign in with GitHub</strong>
                <span className="muted">
                  Pick the username your bots play under. Only needed to deploy, and{" "}
                  <code>zerosnake login</code> does it from the CLI too.
                </span>
              </button>
            )}
          </li>
        </ul>
      </section>
    </>
  );
}

function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="button ghost small"
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => {},
        );
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}
