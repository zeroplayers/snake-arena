import { createFileRoute, Link } from "@tanstack/react-router";
import { ContactEmail, LegalPage } from "../components/LegalPage";

export const Route = createFileRoute("/acceptable-use")({
  head: () => ({ meta: [{ title: "Acceptable Use · ZeroSnake Arena" }] }),
  component: AcceptableUse,
});

function AcceptableUse() {
  return (
    <LegalPage title="Acceptable Use Policy">
      <p>
        Bots are code we run for you, next to everyone else's. These rules keep that safe and the
        game fair. They are part of the <Link to="/terms">Terms of Service</Link>.
      </p>

      <h2>How your code runs</h2>
      <ul>
        <li>
          Every version you deploy is checked first and then runs in a sandbox (QuickJS inside a
          Cloudflare Durable Object) with no network, timers, clock or imports, and with limits on
          operations, memory and size (see{" "}
          <Link to="/docs/$slug" params={{ slug: "limits" }}>
            Limits
          </Link>
          ).
        </li>
        <li>
          We may read your bot's code, bundle, logs and traces, run it in tests, and stop,
          quarantine, reject or remove it at any time, automatically or by hand, for example when it
          keeps hitting the CPU limit or breaks these rules.
        </li>
        <li>Your source code is public on the bot's page; your logs and traces are not.</li>
      </ul>

      <h2>Your bot must not</h2>
      <ul>
        <li>
          try to escape or probe the sandbox, read other bots' data, or reach anything outside the
          game's API;
        </li>
        <li>
          attack the service or anyone else: denial of service, deliberately exhausting CPU or
          memory, exploiting bugs instead of reporting them, scanning, spam;
        </li>
        <li>mine cryptocurrency or do any computation that isn't playing the game;</li>
        <li>contain malware, or code or content you have no right to share;</li>
        <li>contain secrets (API keys, passwords) or other people's personal data;</li>
        <li>
          carry offensive, hateful, sexual or harassing content in its name, code, comments or logs.
        </li>
      </ul>

      <h2>You must not</h2>
      <ul>
        <li>
          get around the limits: several accounts to get more bots, deploys or lives, automating
          sign-ups, or sharing an account;
        </li>
        <li>
          manipulate ratings or the leaderboard, for example by colluding bots across accounts or by
          exploiting a bug;
        </li>
        <li>
          overload the site or API: scrape it faster than a person would, or poll beyond the rate
          limits;
        </li>
        <li>impersonate another person, project or company in your username or bot names;</li>
        <li>use the service for anything illegal.</li>
      </ul>

      <h2>Found a problem?</h2>
      <p>
        If you find a way out of the sandbox, a bug that gives an unfair advantage, or a bot that
        breaks these rules, tell us at <ContactEmail /> instead of using it. Good-faith security
        research that respects other players and stops once you've shown the issue is welcome.
      </p>
    </LegalPage>
  );
}
