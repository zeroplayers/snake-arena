import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { GithubLink } from "../GithubLink";
import { ArenaHero } from "./ArenaHero";
import { HERO_IS_LIVE } from "./heroLive";
import { NOT_YET, QUICKSTART, quickstartScript } from "./quickstart";

const HOW = [
  {
    title: "Vibe-code it",
    body: "Describe a strategy to Claude. The project template ships the rules, the bot API and skills for Claude, so it writes and debugs the snake with you.",
  },
  {
    title: "Ship it",
    body: "One command bundles the bot and uploads it. The server runs it in a sandbox through the same checks you ran locally.",
  },
  {
    title: "Watch it fight",
    body: "Your snake plays everyone else's around the clock in persistent rooms. It earns a rating, and every life leaves a replay.",
  },
] as const;

/** `/`: what ZeroSnake Arena is, a match to watch, and how to get a bot in. */
export function Landing({ signedIn, onSignIn }: { signedIn: boolean; onSignIn: () => void }) {
  return (
    <>
      <section className="landing-hero">
        <div className="landing-head">
          <p className="eyebrow">zeroplayers · zero-player games</p>
          <h1 className="title landing-title">
            Vibe-code a snake bot with Claude. <span className="accent">Deploy it</span> with one
            command. Watch it fight 24/7.
          </h1>
        </div>
        <ArenaHero live={HERO_IS_LIVE} />
        <div className="landing-body">
          <p className="lead">
            ZeroSnake Arena is slither.io played by programs. You describe a strategy, Claude writes
            the bot, <code>npx zerosnake deploy</code> ships it, and it plays everyone else's bots
            in persistent rooms while you watch.
          </p>
          <div className="actions">
            <a href="#start" className="button">
              Start in a minute
            </a>
            <Link to="/docs" className="button ghost">
              Docs
            </Link>
            <Link to="/leaderboard" className="button ghost">
              Leaderboard
            </Link>
          </div>
        </div>
      </section>

      <section aria-labelledby="how" className="landing-section">
        <h2 id="how" className="subtitle">
          How it works
        </h2>
        <ol className="how">
          {HOW.map((step, i) => (
            <li key={step.title} className="panel how-step">
              <span className="how-n" aria-hidden="true">
                {i + 1}
              </span>
              <h3>{step.title}</h3>
              <p className="muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section id="start" aria-labelledby="start-title" className="panel landing-section">
        <div className="start-head">
          <h2 id="start-title" className="subtitle">
            Start in a minute
          </h2>
          <CopyButton text={quickstartScript()} />
        </div>
        <ol className="terminal">
          {QUICKSTART.map(({ cmd, note }) => (
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
        <p className="muted small">
          Needs Node.js 24+.{" "}
          <Link to="/docs/$slug" params={{ slug: "getting-started" }}>
            Getting started
          </Link>{" "}
          walks through every step, with the options of each command.
        </p>
        {NOT_YET.length > 0 && (
          <div className="not-yet">
            <h3 className="small">Before launch</h3>
            <ul>
              {NOT_YET.map((n) => (
                <li key={n.what}>
                  <code>{n.what}</code> {n.detail}
                </li>
              ))}
            </ul>
            <p className="small muted">
              <Link
                to="/docs/$slug"
                params={{ slug: "getting-started" }}
                hash="before-the-packages-are-published"
              >
                Running the CLI from a checkout
              </Link>
            </p>
          </div>
        )}
      </section>

      <section aria-labelledby="next" className="landing-section landing-links">
        <h2 id="next" className="subtitle">
          Go deeper
        </h2>
        <ul className="link-grid">
          <li>
            <Link to="/leaderboard" className="panel link-card">
              <strong>Leaderboard</strong>
              <span className="muted">Every rated bot, ranked by the low end of its rating.</span>
            </Link>
          </li>
          <li>
            <Link to="/docs" className="panel link-card">
              <strong>Docs</strong>
              <span className="muted">Rules, bot API, limits, rating and the FAQ.</span>
            </Link>
          </li>
          <li>
            <div className="panel link-card">
              <strong>
                <GithubLink />
              </strong>
              <span className="muted">
                Engine, sandbox, CLI and this site. Open source at launch.
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
                <span className="muted">Pick a username, then deploy from the CLI.</span>
              </button>
            )}
          </li>
        </ul>
      </section>
    </>
  );
}

function CopyButton({ text }: { text: string }) {
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
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
