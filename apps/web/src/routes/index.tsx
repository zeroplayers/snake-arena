import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Home,
});

const steps = [
  ["npx zerosnake init my-snake", "template with SDK, tests and CLAUDE.md"],
  ["npx zerosnake sim", "local match against house bots"],
  ["npx zerosnake deploy", "checks pass, your bot joins the arena"],
] as const;

function Home() {
  return (
    <>
      <section className="hero">
        <h1 className="title">
          Code a snake. <span className="accent">Ship it.</span> Watch it fight.
        </h1>
        <p className="lead">
          Write a slither.io-style bot in TypeScript, deploy it with one command, and it plays
          everyone else's bots around the clock in persistent rooms.
        </p>
        <div className="actions">
          <Link to="/leaderboard" className="button">
            Leaderboard
          </Link>
        </div>
      </section>

      <section className="panel arena-placeholder" aria-label="Live arena">
        <span className="muted">Live arena broadcast coming soon</span>
      </section>

      <section className="panel">
        <h2 className="subtitle">Get started</h2>
        <ol className="steps">
          {steps.map(([cmd, note]) => (
            <li key={cmd}>
              <code>{cmd}</code>
              <span className="muted">{note}</span>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
