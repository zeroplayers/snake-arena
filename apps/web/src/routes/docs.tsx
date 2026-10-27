import { DOCS } from "virtual:zerosnake-docs";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/docs")({
  component: DocsLayout,
});

function DocsLayout() {
  return (
    <div className="docs">
      <nav className="docs-nav" aria-label="Docs">
        <ul>
          {DOCS.map(({ slug, title }) => (
            <li key={slug}>
              {slug ? (
                <Link to="/docs/$slug" params={{ slug }}>
                  {title}
                </Link>
              ) : (
                <Link to="/docs" activeOptions={{ exact: true }}>
                  Overview
                </Link>
              )}
            </li>
          ))}
        </ul>
      </nav>
      <section className="panel docs-page">
        <Outlet />
      </section>
    </div>
  );
}
