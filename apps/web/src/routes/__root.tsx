/// <reference types="vite/client" />
import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  redirect,
  Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { GithubLink } from "../components/GithubLink";
import { signInWithGithub } from "../lib/auth-client";
import { getViewer } from "../server/functions";
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
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "theme-color", content: "#080808" },
      { title: "ZeroSnake Arena" },
      {
        name: "description",
        content:
          "Vibe-code a snake bot, deploy it with one command, watch it fight around the clock.",
      },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
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
        <header className="site-header">
          <Link to="/" className="logo">
            Zero<span className="accent">Snake</span> <span className="logo-tag">Arena</span>
          </Link>
          <nav className="site-nav">
            <Link to="/leaderboard">Leaderboard</Link>
            <Link to="/docs">Docs</Link>
            {viewer?.username ? (
              <>
                <Link to="/@{$username}" params={{ username: viewer.username }}>
                  @{viewer.username}
                </Link>
                <Link to="/bots">Bots</Link>
                <Link to="/settings">Settings</Link>
              </>
            ) : viewer ? null : (
              <button type="button" className="button small" onClick={() => signInWithGithub()}>
                Sign in with GitHub
              </button>
            )}
          </nav>
        </header>
        <main className="site-main">
          <Outlet />
        </main>
        <footer className="site-footer">
          <span>
            ZeroSnake is a <strong>zeroplayers</strong> game: code plays, people watch.
          </span>
          <span className="footer-links">
            <Link to="/docs">Docs</Link>
            <GithubLink />
          </span>
        </footer>
      </div>
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function NotFound() {
  return (
    <section className="panel">
      <h1 className="title red">404</h1>
      <p className="muted">This snake slithered off the map.</p>
      <Link to="/" className="button">
        Back to the arena
      </Link>
    </section>
  );
}
