import { readFileSync } from "node:fs";
import { DOCS, loadDoc } from "virtual:zerosnake-docs";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocArticle } from "../docs/DocArticle";
import { Landing } from "./Landing";
import { QUICKSTART, quickstartScript } from "./quickstart";

const ROOT = new URL("../../../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), "utf8");

/** Every page path the app routes, from the generated route tree. */
const ROUTES = [
  ...read("apps/web/src/routeTree.gen.ts").matchAll(/^ {2}'(\/[^']*)': typeof \w+$/gm),
].map((m) => m[1] as string);

/** Server-renders `node` at `path` inside a router, as the app does. */
async function renderAt(path: string, node: () => ReactNode): Promise<string> {
  const root = createRootRoute({ component: Outlet });
  const index = createRoute({ getParentRoute: () => root, path: "/", component: node });
  const rest = createRoute({ getParentRoute: () => root, path: "$", component: node });
  const router = createRouter({
    routeTree: root.addChildren([index, rest]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  return renderToString(<RouterProvider router={router} />);
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => (m[1] as string).replace(/&amp;/g, "&"));
}

/** Whether a site path is a page: a route, or a doc page with that heading. */
async function resolves(href: string): Promise<boolean> {
  const [path = "", anchor] = href.split("#");
  if (path === "") return true;
  if (path.startsWith("/docs")) {
    const slug = path === "/docs" ? "" : path.slice("/docs/".length);
    const doc = await loadDoc(slug);
    return !!doc && (!anchor || doc.anchors.includes(anchor));
  }
  return ROUTES.includes(path);
}

describe("landing page", () => {
  it("renders the pitch, the arena stage and the quick start", async () => {
    const html = await renderAt("/", () => <Landing signedIn={false} onSignIn={() => {}} />);
    expect(html).toContain("Vibe-code a snake bot with Claude.");
    expect(html).toContain("Watch it fight 24/7.");
    expect(html).toContain('class="hero-stage"');
    expect(html).toContain("Loading the arena");
    for (const { cmd } of QUICKSTART) expect(html).toContain(cmd);
    expect(html).toContain("Sign in with GitHub");
    expect(html).toContain("Before launch");
  });

  it("offers the bots page instead of sign-in when signed in", async () => {
    const html = await renderAt("/", () => <Landing signedIn onSignIn={() => {}} />);
    expect(html).not.toContain("Sign in with GitHub");
    expect(hrefs(html)).toContain("/bots");
  });

  it("only links pages that exist", async () => {
    const links = hrefs(await renderAt("/", () => <Landing signedIn onSignIn={() => {}} />));
    expect(links).toEqual(
      expect.arrayContaining([
        "#start",
        "/docs",
        "/leaderboard",
        "/docs/getting-started#before-the-packages-are-published",
      ]),
    );
    for (const href of links) {
      if (href.startsWith("https://")) continue;
      expect(await resolves(href), href).toBe(true);
    }
  });

  it("lists commands the CLI has and the getting-started page documents", () => {
    const cli = read("packages/cli/src/cli.ts");
    const guide = read("docs/getting-started.md");
    for (const { cmd } of QUICKSTART) {
      const sub = cmd.match(/^npx zerosnake (\w+)/)?.[1];
      if (sub) expect(cli, cmd).toContain(`case "${sub}":`);
      if (sub) expect(guide, cmd).toContain(`npx zerosnake ${sub}`);
    }
    expect(quickstartScript().split("\n")).toHaveLength(QUICKSTART.length);
  });
});

describe("docs pages", () => {
  it("render every page into the article, with raw HTML escaped", async () => {
    for (const { slug, title } of DOCS) {
      const doc = await loadDoc(slug);
      if (!doc) throw new Error(`no page for "${slug}"`);
      const html = await renderAt(slug ? `/docs/${slug}` : "/docs", () => (
        <DocArticle html={doc.html} />
      ));
      expect(html).toContain('<article class="doc">');
      expect(html).toContain(`>${title.replace(/&/g, "&amp;")}</h1>`);
      expect(html).not.toMatch(/<script(?![^>]*\$tsr)/);
    }
  });

  it("link only to doc pages and headings that exist", async () => {
    for (const { slug } of DOCS) {
      const doc = await loadDoc(slug);
      for (const href of hrefs(doc?.html ?? "")) {
        if (/^https?:/.test(href)) continue;
        const target = href.startsWith("#") ? `/docs${slug ? `/${slug}` : ""}${href}` : href;
        expect(await resolves(target), `${slug}: ${href}`).toBe(true);
      }
    }
  });
});
