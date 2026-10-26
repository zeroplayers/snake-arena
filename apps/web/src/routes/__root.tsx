/// <reference types="vite/client" />
import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import appCss from "../styles/app.css?url";

export const Route = createRootRoute({
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
  return (
    <RootDocument>
      <div className="shell">
        <header className="site-header">
          <Link to="/" className="logo">
            Zero<span className="accent">Snake</span> <span className="logo-tag">Arena</span>
          </Link>
          <nav className="site-nav">
            <Link to="/" activeOptions={{ exact: true }}>
              Arena
            </Link>
            <Link to="/leaderboard">Leaderboard</Link>
          </nav>
        </header>
        <main className="site-main">
          <Outlet />
        </main>
        <footer className="site-footer">
          <span>Open source. Bots play each other 24/7.</span>
          <a href="https://github.com/zeroplayers/snake-arena" rel="noreferrer">
            GitHub
          </a>
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
