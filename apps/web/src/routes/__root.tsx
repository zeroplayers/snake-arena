/// <reference types="vite/client" />
import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  redirect,
  Scripts,
  useLocation,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AnalyticsBeacon } from "../components/AnalyticsBeacon";
import { GithubLink, GithubMark } from "../components/GithubLink";
import { LEGAL } from "../legal";
import { signInWithGithub } from "../lib/auth-client";
import { siteMeta } from "../lib/meta";
import { getViewer } from "../server/functions";
import { getSiteConfig } from "../server/site-config";
import { CLI_PUBLISHED, NPM_URL, REPO } from "../site";
import appCss from "../styles/app.css?url";

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    const viewer = await getViewer();
    // A username is chosen once, right after the first GitHub sign-in.
    if (viewer && !viewer.username && location.pathname !== "/welcome") {
      throw redirect({ to: "/welcome", search: { next: location.href } });
    }
    return { viewer };
  },
  // Per-environment and fixed for the Worker's life: read once, at the server render.
  loader: () => getSiteConfig(),
  staleTime: Number.POSITIVE_INFINITY,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "theme-color", content: "#080808" },
      ...siteMeta(),
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico", sizes: "32x32" },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      { rel: "manifest", href: "/site.webmanifest" },
    ],
  }),
  component: RootLayout,
  notFoundComponent: NotFound,
});

function RootLayout() {
  const { viewer } = Route.useRouteContext();
  return (
    <RootDocument>
      <div className="shell">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <header className="site-header">
          <Link to="/" className="logo">
            Zero<span className="accent">Snake</span> <span className="logo-tag">Arena</span>
          </Link>
          <nav className="site-nav">
            <Link to="/leaderboard">Leaderboard</Link>
            <Link to="/docs">Docs</Link>
            {REPO.public && <GithubLink className="hide-narrow" />}
            {viewer?.username ? (
              <>
                <Link to="/@{$username}" params={{ username: viewer.username }}>
                  @{viewer.username}
                </Link>
                <Link to="/bots">Bots</Link>
                <Link to="/settings">Settings</Link>
              </>
            ) : viewer ? null : (
              <button
                type="button"
                className="button ghost small"
                onClick={() => signInWithGithub()}
              >
                <GithubMark />
                Sign in<span className="hide-narrow sign-in-more">with GitHub</span>
              </button>
            )}
          </nav>
        </header>
        <main id="main" className="site-main">
          <Outlet />
        </main>
        <footer className="site-footer">
          <span>
            ZeroSnake Arena is a <strong>zeroplayers</strong> game: code plays, people watch.
          </span>
          <span className="footer-links">
            <Link to="/docs/$slug" params={{ slug: "rules" }}>
              Rules
            </Link>
            <Link to="/leaderboard">Leaderboard</Link>
            <Link to="/docs">Docs</Link>
            <GithubLink />
            {CLI_PUBLISHED && <a href={NPM_URL}>npm</a>}
            <Link to="/terms">Terms</Link>
            <Link to="/acceptable-use">Acceptable Use</Link>
            <Link to="/privacy">Privacy</Link>
            <a href={LEGAL.x.url} target="_blank" rel="me noopener">
              Made by {LEGAL.x.handle}
              <span className="sr-only"> on X (opens in a new tab)</span>
            </a>
          </span>
          <small className="footer-company">
            {LEGAL.operator}, registered in England and Wales, company number {LEGAL.companyNumber}.
            Registered office: {LEGAL.address}.
          </small>
        </footer>
      </div>
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  const { beaconToken } = Route.useLoaderData();
  // The CLI's one-time code is in the device page's URL, and in `/welcome?next=` on the way there.
  const analytics = useLocation({
    select: (l) => !l.pathname.startsWith("/device") && !l.href.includes("user_code"),
  });
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <AnalyticsBeacon token={analytics ? beaconToken : null} />
        <Scripts />
      </body>
    </html>
  );
}

function NotFound() {
  return (
    <section className="panel">
      <h1 className="title">Nothing here</h1>
      <p className="muted">
        This snake slithered off the map. If you followed a link to a bot, check the username and
        the bot's name, or find it on the leaderboard.
      </p>
      <div className="actions">
        <Link to="/" className="button">
          Home
        </Link>
        <Link to="/leaderboard" className="button ghost">
          Leaderboard
        </Link>
      </div>
    </section>
  );
}
