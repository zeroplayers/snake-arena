import { createFileRoute, Link } from "@tanstack/react-router";
import { ContactEmail, LegalPage } from "../components/LegalPage";
import { LEGAL, MINIMUM_AGE } from "../legal";
import { TRACE_RETENTION_DAYS } from "../shared";

export const Route = createFileRoute("/privacy")({
  head: () => ({ meta: [{ title: "Privacy Policy · ZeroSnake Arena" }] }),
  component: Privacy,
});

function Privacy() {
  return (
    <LegalPage title="Privacy Policy">
      <p>
        This page says what personal data ZeroSnake Arena keeps, why, for how long, who else handles
        it, and how to get a copy or have it deleted. It describes what the site's code actually
        does; the code is open source.
      </p>
      <p>
        The controller is {LEGAL.operator}, {LEGAL.address}. For anything about your data, write to{" "}
        <ContactEmail />.
      </p>

      <h2>In short</h2>
      <ul>
        <li>We know what GitHub tells us when you sign in, and what your bots do here.</li>
        <li>
          No advertising, no tracking cookies, no selling or sharing of personal data, no
          third-party scripts other than Cloudflare's cookieless analytics.
        </li>
        <li>
          You can download everything and delete your account yourself, in{" "}
          <Link to="/settings">Settings</Link>.
        </li>
      </ul>

      <h2>What we collect</h2>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Data</th>
              <th>Where it comes from, what for</th>
              <th>Kept</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                GitHub account: numeric id, login, display name, primary email address and whether
                it's verified, avatar URL; the OAuth access token (encrypted)
              </td>
              <td>
                From GitHub when you sign in (scopes <code>read:user</code>, <code>user:email</code>
                ). To identify your account and suggest a username. Your email address and name are
                never shown publicly; your avatar is shown on your profile. We don't use the token
                after sign-in.
              </td>
              <td>Until you delete your account</td>
            </tr>
            <tr>
              <td>Username</td>
              <td>You choose it. Public: it names your profile and bots.</td>
              <td>Until you delete your account</td>
            </tr>
            <tr>
              <td>
                Web sessions: IP address and browser user agent at sign-in, creation and expiry
              </td>
              <td>
                Kept by the sign-in system with each session, to keep you signed in and to spot
                misuse. After you sign out, only a one-way hash of the session token remains, so the
                sign-out holds.
              </td>
              <td>30 days after last use; hashes until the session would have expired</td>
            </tr>
            <tr>
              <td>
                CLI sign-in: the device code while you confirm it; for each{" "}
                <code>zerosnake login</code>, a hash of the token (never the token), the CLI's user
                agent and IP address, when it was created and last used
              </td>
              <td>
                So the CLI can deploy for you, and so you can see and revoke your logins in
                Settings.
              </td>
              <td>Device codes 10 minutes; tokens until revoked or 90 days after last use</td>
            </tr>
            <tr>
              <td>
                Bots: names, skins, every version's source files and bundle, what the CLI sent with
                it (CLI and SDK version, message), check reports, status changes
              </td>
              <td>
                You upload them. To run your bots and show them. Source code is public on the bot's
                page.
              </td>
              <td>Until you delete your account</td>
            </tr>
            <tr>
              <td>
                Games: each life of your bots (room, ticks, score, length, kills, how it died and
                who killed it, times) and ratings
              </td>
              <td>Made by the arena. Public: bot pages, the leaderboard, replays.</td>
              <td>Until you delete your account</td>
            </tr>
            <tr>
              <td>Replays</td>
              <td>
                Recordings of whole rooms, public. They name snakes only by random ids; the site
                looks up the bot and username when you open one.
              </td>
              <td>2 days; replays of the best lives for as long as they rank among the best</td>
            </tr>
            <tr>
              <td>Traces: what your bot logged and decided, tick by tick</td>
              <td>Made by the arena. Visible only to you.</td>
              <td>{TRACE_RETENTION_DAYS} days</td>
            </tr>
            <tr>
              <td>Moderation: bans, quarantines, their reasons, and a log of admin actions</td>
              <td>To keep the arena safe and fair, and to answer appeals.</td>
              <td>
                Bans and quarantines with the account; the admin log (ids only) as long as it is
                needed to prevent abuse
              </td>
            </tr>
            <tr>
              <td>IP address of each request</td>
              <td>
                Used, never stored by us, to rate-limit requests (Cloudflare keeps the counter for
                one minute) and to cap live-arena connections per visitor (as a hash, in memory,
                while connected).
              </td>
              <td>Not stored</td>
            </tr>
            <tr>
              <td>
                Request logs: time, route, status, latency, request id and your user id if signed
                in; Cloudflare's invocation logs add request details such as the URL, country and
                user agent
              </td>
              <td>To run, debug and secure the service (Cloudflare Workers Logs).</td>
              <td>Up to 7 days</td>
            </tr>
            <tr>
              <td>
                Service metrics: counts of deploys (with your user id), lives (with the version id),
                errors and rate-limited requests
              </td>
              <td>To watch the arena's health (Cloudflare Workers Analytics Engine).</td>
              <td>Up to 3 months</td>
            </tr>
            <tr>
              <td>Page views: page URL, referrer, browser, device type, country, load times</td>
              <td>
                Cloudflare Web Analytics, cookieless: no cookies, no local storage, no
                fingerprinting, no cross-site tracking. Only aggregate numbers reach us.
              </td>
              <td>As Cloudflare keeps them; we see aggregates only</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        We don't ask for, and don't want, any special categories of data. We don't send marketing
        email. We don't make automated decisions with legal or similar effects; the automated checks
        and quarantines only concern your bot's code.
      </p>

      <h2>Why we may use it (legal bases)</h2>
      <ul>
        <li>
          <strong>To provide the service you signed up for</strong> (contract, GDPR art. 6(1)(b)):
          your account, sessions, CLI tokens, running and showing your bots and their games.
        </li>
        <li>
          <strong>Legitimate interests</strong> (art. 6(1)(f)): security, rate limiting, logs,
          metrics and cookieless analytics to keep the service working; moderation and its log to
          prevent abuse and cheating. You can object; we'll then stop unless we have compelling
          reasons, such as preventing abuse.
        </li>
        <li>
          <strong>Legal obligations</strong> (art. 6(1)(c)): when the law requires us to keep or
          disclose something.
        </li>
      </ul>

      <h2>Who else handles it</h2>
      <ul>
        <li>
          <strong>Cloudflare, Inc.</strong> hosts the whole service (Workers, D1, R2, KV, Durable
          Objects, Queues, logs, Analytics Engine, Web Analytics) and protects it from attacks. It
          processes data for us under its Data Processing Addendum.
        </li>
        <li>
          <strong>GitHub, Inc.</strong> handles the sign-in. GitHub's own privacy statement covers
          your GitHub account; we receive only what is listed above.
        </li>
      </ul>
      <p>
        We don't sell personal data or share it for advertising, and we don't give it to anyone else
        unless the law requires us to.
      </p>

      <h2>International transfers</h2>
      <p>
        Cloudflare runs a global network and GitHub is in the United States, so your data may be
        processed outside your country, including in the US. Where the GDPR or the UK GDPR applies,
        those transfers rely on the EU-US Data Privacy Framework (and its UK extension), in which
        both companies take part, and on the European Commission's standard contractual clauses.
      </p>

      <h2>Deleting your account</h2>
      <p>
        <Link to="/settings">Settings</Link> → <em>Delete my account</em>. At once: your name,
        email, avatar, GitHub login and username are erased, the link to your GitHub account and
        your CLI tokens are deleted, every session is signed out, and your bots stop playing and
        leave your profile, the leaderboard and every page. Within about an hour: your bots, their
        versions, source code, bundles, ratings, lives and traces are erased.
      </p>
      <p>
        What stays: other players' games keep the fact that a snake, now a “deleted bot”, took part,
        without your name; recorded replays expire on their own schedule (above); logs and metrics
        age out as listed; the moderation log keeps ids that no longer lead to you. Database backups
        (Cloudflare D1 point-in-time recovery) roll over within 30 days. If you sign in with the
        same GitHub account later, you start a new, empty account.
      </p>

      <h2>Your rights</h2>
      <p>Wherever you live, you can ask us to:</p>
      <ul>
        <li>
          <strong>give you a copy</strong> of your data (access, portability): Settings →{" "}
          <em>Download my data</em>, a JSON file with links to your bundles and sources;
        </li>
        <li>
          <strong>delete it</strong>: in Settings, with <em>Delete my account</em> (see above);
        </li>
        <li>
          <strong>correct it</strong>: your name and avatar come from GitHub at your first sign-in;
          write to us to change anything we hold;
        </li>
        <li>
          <strong>restrict</strong> or <strong>object to</strong> some uses, as described above.
        </li>
      </ul>
      <p>
        Write to <ContactEmail /> for anything Settings doesn't do. We answer within one month
        (California residents: within 45 days), and may ask you to prove the account is yours, for
        example by writing from the email address GitHub gave us. In the EU and UK you can also
        complain to your data protection authority. California residents: we don't sell or share
        personal information, don't use sensitive personal information, and won't treat you
        differently for using these rights.
      </p>

      <h2>Cookies and local storage</h2>
      <p>
        The site uses only cookies that are strictly necessary to sign you in, so it doesn't ask for
        consent. It stores nothing in your browser's local storage, and the analytics are
        cookieless.
      </p>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Cookie</th>
              <th>Purpose</th>
              <th>Lasts</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>__Secure-better-auth.session_token</code>
              </td>
              <td>Keeps you signed in (HttpOnly, first party)</td>
              <td>30 days, renewed as you use the site; removed when you sign out</td>
            </tr>
            <tr>
              <td>
                <code>__Secure-better-auth.state</code>
              </td>
              <td>Protects the GitHub sign-in against forgery</td>
              <td>5 minutes, during sign-in</td>
            </tr>
            <tr>
              <td>
                <code>__cf_bm</code>, <code>cf_clearance</code>
              </td>
              <td>Set by Cloudflare only if it has to check for bots or attacks</td>
              <td>Up to 30 minutes / as Cloudflare sets</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        The <code>zerosnake</code> CLI keeps its token in a file in your home directory; that stays
        on your computer.
      </p>

      <h2>Children</h2>
      <p>
        You must be at least {MINIMUM_AGE} to have an account. The service is not aimed at children.
        If you believe a child under {MINIMUM_AGE} has an account, tell us and we'll delete it.
      </p>

      <h2>Security</h2>
      <p>
        Everything travels over HTTPS. Session tokens are kept away from the part of the service
        that runs bot code, CLI tokens are stored only as hashes, GitHub tokens are encrypted, and
        bot code runs in a sandbox. No system is perfectly secure; if we learn of a breach that
        affects you, we'll tell you and the authorities as the law requires.
      </p>

      <h2>Changes</h2>
      <p>
        We'll update this page when what we do with data changes, and announce important changes on
        the site. The date at the top says when it last changed.
      </p>
    </LegalPage>
  );
}
