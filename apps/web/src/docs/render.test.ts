import { readdirSync, readFileSync } from "node:fs";
import { DOCS, loadDoc } from "virtual:zerosnake-docs";
import { describe, expect, it } from "vitest";
import { REPO } from "../site";
import { docPath, githubSlug, renderDoc } from "./render";

const DOCS_DIR = new URL("../../../../docs/", import.meta.url);
const OPTIONS = { pages: ["README.md", "rules.md"], repoUrl: REPO.url, branch: "main" };

const render = (markdown: string, file = "faq.md") => renderDoc(file, markdown, OPTIONS);

describe("renderDoc", () => {
  it("escapes raw HTML instead of passing it through", () => {
    const { html } = render(
      [
        "# Title",
        "",
        "<script>alert(1)</script>",
        "",
        'Inline <img src=x onerror="alert(1)"> and <a href="javascript:alert(1)">x</a>.',
        "",
        "<div onclick=alert(1)>block</div>",
      ].join("\n"),
    );
    expect(html).not.toMatch(/<script|<img|<div|<a href="javascript/i);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("drops script link targets", () => {
    const { html } = render(
      "[a](javascript:alert(1)) [b](JAVASCRIPT:alert(1)) [c](vbscript:x) [d](data:text/html,x)\n\n![i](javascript:alert(1))",
    );
    expect(html).not.toMatch(/(href|src)="(javascript|vbscript|data):/i);
  });

  it("gives headings GitHub's ids and takes the title from the first h1", () => {
    const doc = render(
      "# Bot API\n\n## `tick(state)` returns\n\n## Food & growth\n\n## Food & growth\n",
    );
    expect(doc.title).toBe("Bot API");
    expect(doc.anchors).toEqual(["bot-api", "tickstate-returns", "food--growth", "food--growth-1"]);
    expect(doc.html).toContain('<h2 id="food--growth-1">');
  });

  it("links pages on the site and other repository files on GitHub", () => {
    const { html } = render(
      [
        "[rules](rules.md#food) [index](README.md) [here](#top)",
        "[config](../packages/engine/src/config.ts) [template](../template/)",
        "[site](https://claude.com/claude-code) [missing](nope.md)",
      ].join("\n"),
    );
    expect(html).toContain('href="/docs/rules#food"');
    expect(html).toContain('href="/docs"');
    expect(html).toContain('href="#top"');
    expect(html).toContain(`href="${REPO.url}/blob/main/packages/engine/src/config.ts"`);
    expect(html).toContain(`href="${REPO.url}/blob/main/template"`);
    expect(html).toContain('href="https://claude.com/claude-code" rel="noreferrer"');
    expect(html).toContain(`href="${REPO.url}/blob/main/docs/nope.md"`);
  });

  it("wraps tables so they scroll on narrow screens", () => {
    expect(render("| a | b |\n| - | - |\n| 1 | 2 |").html).toContain(
      '<div class="table-scroll"><table class="table">',
    );
  });

  it("slugs like GitHub", () => {
    expect(githubSlug("Before the packages are published")).toBe(
      "before-the-packages-are-published",
    );
    expect(githubSlug("Limits: check suite & qualification")).toBe(
      "limits-check-suite--qualification",
    );
  });
});

describe("the docs/ pages", () => {
  const files = readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md"));

  it("are all served, the index first, in README's order", async () => {
    expect(DOCS.map((d) => d.slug).sort()).toEqual(
      files.map((f) => (f === "README.md" ? "" : f.replace(/\.md$/, ""))).sort(),
    );
    expect(DOCS[0]?.slug).toBe("");
    expect(DOCS.find((d) => d.slug === "getting-started")?.title).toBe("Getting started");
    const readme = readFileSync(new URL("README.md", DOCS_DIR), "utf8");
    const linked = DOCS.slice(1).map((d) => readme.indexOf(`](${d.slug}.md`));
    expect(linked.every((at) => at >= 0)).toBe(true);
    expect(linked).toEqual([...linked].sort((a, b) => a - b));
  });

  it("render without raw HTML, and every site link points at a page and heading that exist", async () => {
    const pages = new Map<string, readonly string[]>();
    const links: { from: string; href: string }[] = [];
    for (const { slug } of DOCS) {
      const doc = await loadDoc(slug);
      if (!doc) throw new Error(`no page for "${slug}"`);
      expect(doc.title, slug).not.toBe("");
      expect(doc.html, slug).not.toMatch(/<(script|iframe|object|style)\b/i);
      pages.set(docPath(slug), doc.anchors);
      for (const m of doc.html.matchAll(/href="([^"]*)"/g))
        links.push({ from: slug, href: m[1] as string });
    }
    expect(links.length).toBeGreaterThan(20);
    for (const { from, href } of links) {
      if (/^https?:\/\//.test(href)) continue;
      const [path = "", anchor] = href.split("#");
      const target = path === "" ? docPath(from) : path;
      expect(pages.has(target), `${from}: ${href}`).toBe(true);
      if (anchor) expect(pages.get(target), `${from}: ${href}`).toContain(anchor);
    }
  });

  it("has no page for an unknown slug", async () => {
    expect(await loadDoc("nope")).toBeUndefined();
    expect(await loadDoc("toString")).toBeUndefined();
    expect(await loadDoc("README")).toBeUndefined();
  });
});
