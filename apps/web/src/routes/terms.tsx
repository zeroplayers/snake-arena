import { createFileRoute, Link } from "@tanstack/react-router";
import { ContactEmail, LegalPage } from "../components/LegalPage";
import { LEGAL, MINIMUM_AGE } from "../legal";

export const Route = createFileRoute("/terms")({
  head: () => ({ meta: [{ title: "Terms of Service · ZeroSnake Arena" }] }),
  component: Terms,
});

function Terms() {
  return (
    <LegalPage title="Terms of Service">
      <p>
        ZeroSnake Arena (“the service”) is a free game where people write snake bots and the bots
        play each other on this site. It is run by {LEGAL.operator}, {LEGAL.registration},
        registered office {LEGAL.address} (“we”, “us”). By creating an account or deploying a bot
        you agree to these terms, to the <Link to="/acceptable-use">Acceptable Use Policy</Link>,
        which is part of them, and to how we handle data as described in the{" "}
        <Link to="/privacy">Privacy Policy</Link>. You can watch games, replays and the leaderboard
        without an account.
      </p>

      <h2>Your account</h2>
      <ul>
        <li>
          You sign in with your GitHub account. You need to be at least {MINIMUM_AGE} years old.
          Keep your GitHub account and the tokens <code>zerosnake login</code> stores on your
          computer safe: what is done with them counts as done by you.
        </li>
        <li>
          One person, one account. The username you choose is public, may not impersonate anyone and
          may not be offensive. We may take back a username that breaks these terms.
        </li>
        <li>
          You can delete your account at any time in <Link to="/settings">Settings</Link>. What that
          removes, and when, is in the Privacy Policy.
        </li>
      </ul>

      <h2>Your bots and your code</h2>
      <ul>
        <li>You keep every right you have in the code you upload. We claim no ownership of it.</li>
        <li>
          To run the service you give us a worldwide, non-exclusive, royalty-free licence to store,
          copy, run, analyse and publicly display your bots' source code, bundles, names and the
          games they play, for as long as they are on the service and as needed to operate, secure
          and show the service (including in replays, on the leaderboard and in promotion of the
          game). The licence ends when you delete your account (archiving a bot or a version keeps
          it, and its source, on the site), apart from replays of other players' games your bot took
          part in, which expire on their own.
        </li>
        <li>
          <strong>The source code of every version you deploy is public</strong>: anyone can read it
          on the bot's page. This licence gives other people no right to reuse it; if you want them
          to, put an open-source licence in your code. Don't upload code you have no right to share,
          or secrets such as API keys.
        </li>
        <li>
          Your bots' logs and traces are visible only to you (in the <code>zerosnake</code> CLI and
          on replay pages while signed in).
        </li>
        <li>
          Bots run in our sandbox, under limits, on our schedule. We decide how rooms, matchmaking,
          ratings and the leaderboard work, and may change them, reset ratings or remove results
          that came from a bug or from breaking these terms.
        </li>
      </ul>

      <h2>Moderation</h2>
      <p>
        We may inspect any bot's code and behaviour, and reject, stop, quarantine or ban a version,
        a bot or an account, with or without notice, if we believe it breaks these terms, harms the
        service or other players, or the law requires it. Where we can, we say why on the bot's page
        or in the CLI. A banned account can still sign in and see its data, download it and delete
        itself, but can't deploy. If you think we got it wrong, write to <ContactEmail />.
      </p>

      <h2>A free service, as is</h2>
      <ul>
        <li>
          The service is free and provided <strong>“as is” and “as available”</strong>, without
          warranties of any kind, express or implied, including fitness for a particular purpose,
          availability, accuracy of ratings and results, and that stored data won't be lost. Keep
          your own copy of your code.
        </li>
        <li>
          We may change, pause or end the service, or any part of it, at any time. If we shut it
          down for good, we'll try to announce it on the site at least 30 days ahead so you can
          download your data.
        </li>
        <li>
          To the extent the law allows, we are not liable for any indirect, incidental, special or
          consequential damages, or for lost data, profits or goodwill, and our total liability for
          any claim about the service is limited to £50. Nothing in these terms limits liability
          that cannot be limited by law, such as for death or personal injury caused by negligence,
          or for fraud, and nothing takes away rights you have as a consumer under the laws of the
          country where you live.
        </li>
      </ul>

      <h2>Ending</h2>
      <p>
        You can stop using the service and delete your account whenever you want. We may suspend or
        close an account that breaks these terms. Sections about your licence to us (for what we
        already showed), warranties and liability survive.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms. For changes that matter, we'll show a notice on the site before
        they take effect; continuing to use the service after that means you accept them. The date
        at the top says when they last changed.
      </p>

      <h2>Law and disputes</h2>
      <p>
        These terms are governed by {LEGAL.governingLaw}, and disputes go to {LEGAL.courts}. If you
        live in Scotland or Northern Ireland you may also bring proceedings there, and if you live
        elsewhere as a consumer, the mandatory consumer protections of your country still apply. If
        one part of these terms is invalid, the rest still applies.
      </p>

      <h2>Contact</h2>
      <p>
        {LEGAL.operator}, {LEGAL.registration}. Registered office: {LEGAL.address}. Email:{" "}
        <ContactEmail />.
      </p>
    </LegalPage>
  );
}
