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
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLI_PUBLISHED, REPO, SITE_URL } from "../../site";
import { DocArticle } from "../docs/DocArticle";
import { claudePrompt, claudePromptWorks } from "./claudePrompt";
import { Landing } from "./Landing";
import { QUICKSTART_COMMANDS, quickstartScript } from "./quickstart";

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
    expect(html).toContain("Your snake bot vs.");
    expect(html).toContain("every snake is a program");
    expect(html).toContain('class="hero-stage"');
    expect(html).toContain("Loading the arena");
    expect(html).toContain("Your bot is one function");
    for (const { cmd } of QUICKSTART_COMMANDS) expect(html).toContain(cmd);
    expect(html).toContain("Sign in with GitHub");
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
        "/docs",
        "/leaderboard",
        // The hero's second button: the start section once the CLI is on npm, building from a
        // checkout while only the repo is public, and "Build your bot" before either.
        claudePromptWorks()
          ? CLI_PUBLISHED
            ? "#by-hand"
            : "/docs/getting-started#working-from-a-checkout"
          : "#start",
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
    for (const { cmd } of QUICKSTART_COMMANDS) {
      const sub = cmd.match(/^npx zerosnake (\w+)/)?.[1];
      if (sub) expect(cli, cmd).toContain(`case "${sub}":`);
      if (sub) expect(guide, cmd).toContain(`npx zerosnake ${sub}`);
    }
    expect(quickstartScript()).toBe(
      "npx zerosnake init my-snake && cd my-snake && npx zerosnake sim",
    );
  });
});

describe.each([
  { cli: false, repo: false },
  { cli: false, repo: true },
  { cli: true, repo: false },
  { cli: true, repo: true },
])("landing page with CLI_PUBLISHED=$cli and REPO.public=$repo", ({ cli, repo }) => {
  /** The page rendered against `site.ts` with these flags. */
  async function render(): Promise<string> {
    vi.resetModules();
    vi.doMock("../../site", async (importOriginal) => {
      const site = await importOriginal<typeof import("../../site")>();
      return { ...site, CLI_PUBLISHED: cli, REPO: { ...site.REPO, public: repo } };
    });
    const { Landing } = await import("./Landing");
    return renderAt("/", () => <Landing signedIn={false} onSignIn={() => {}} />);
  }

  afterEach(() => {
    vi.doUnmock("../../site");
  });

  it(
    cli ? "offers the commands to copy" : "shows the commands as coming at launch, with no copy",
    async () => {
      const html = await render();
      for (const { cmd } of QUICKSTART_COMMANDS) expect(html).toContain(cmd);
      expect(html.includes("Copy first steps")).toBe(cli);
      expect(html.includes("Coming at launch")).toBe(!cli);
      // On launch day nothing is left in the "not yet" box, so it's gone.
      expect(html.includes("Not on npm yet")).toBe(!cli);
    },
  );

  it(
    cli || repo
      ? "offers the Claude prompt to copy, and to read first"
      : "says the Claude prompt comes at launch, and shows no prompt",
    async () => {
      const html = await render();
      // No runnable prompt before it can work: `npx zerosnake` isn't ours on npm yet.
      expect(html.includes("Read the prompt")).toBe(cli || repo);
      expect(html.includes("Help me build a snake bot")).toBe(cli || repo);
      expect(html.includes("Copy prompt for Claude")).toBe(cli || repo);
      // The first three steps, sign-in included, are in the hero either way.
      expect(html).toContain("opens your browser to sign in");
      // Hero steps only offer `npx zerosnake` once it's on npm; before, a checkout.
      expect(html.includes("<code>npx zerosnake login</code> opens")).toBe(cli);
      expect(html.includes("build the CLI from a checkout")).toBe(repo && !cli);
    },
  );

  it(repo ? "links the repository" : "doesn't link the private repository", async () => {
    const html = await render();
    const links = hrefs(html);
    expect(links.some((href) => href.startsWith(REPO.url))).toBe(repo);
    expect(links.includes("/docs/getting-started#working-from-a-checkout")).toBe(repo && !cli);
    expect(html.includes("Running the CLI from a checkout")).toBe(repo && !cli);
    expect(html.includes("from a checkout of the repository")).toBe(repo && !cli);
  });
});

describe("Claude prompt", () => {
  const cli = read("packages/cli/src/cli.ts");
  const commands = (prompt: string) => [
    ...prompt.matchAll(/(?:npx zerosnake|zerosnake\.js) (\w+)/g),
  ];

  it("walks an agent from init to deploy with the published CLI", () => {
    const prompt = claudePrompt({ cli: true, repo: true });
    expect(commands(prompt).map((m) => m[1])).toEqual(
      expect.arrayContaining(["init", "sim", "test", "login", "deploy"]),
    );
    for (const [, sub] of commands(prompt)) expect(cli).toContain(`case "${sub}":`);
    // The template's rules: never the blocking viewer, and login is the person's to run.
    expect(prompt).toContain("npx zerosnake sim --headless");
    expect(prompt).toContain("Ask me to run `npx zerosnake login` myself");
    expect(prompt).toContain("sign in with GitHub");
    expect(prompt).not.toContain("git clone");
  });

  it("builds the CLI from source while it isn't on npm but the repository is public", () => {
    const prompt = claudePrompt({ cli: false, repo: true });
    expect(prompt).toContain(`git clone ${REPO.url}`);
    expect(prompt).toContain("npx pnpm@11 --filter zerosnake build");
    expect(prompt).not.toContain("corepack");
    expect(prompt).not.toContain("npx zerosnake");
    for (const [, sub] of commands(prompt)) expect(cli).toContain(`case "${sub}":`);
  });

  it("reads as on launch day while nothing is public", () => {
    expect(claudePrompt({ cli: false, repo: false })).toBe(
      claudePrompt({ cli: true, repo: false }),
    );
  });
});

describe("site URL", () => {
  it("is the CLI's default server, so links in previews and the CLI agree", () => {
    const config = read("packages/cli/src/remote/config.ts");
    expect(config).toContain(`export const DEFAULT_URL = "${SITE_URL}";`);
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
