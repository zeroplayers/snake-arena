/**
 * Keeps `public/sitemap.xml` in step with the site: every page with a fixed canonical URL and
 * every doc page is listed, and nothing else is.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SITE_URL } from "./site";

const SRC = import.meta.dirname;
const sitemap = readFileSync(join(SRC, "../public/sitemap.xml"), "utf8");
const listed = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1] as string);

/** Paths the routes declare with `canonical("/…")`, a literal: the public pages with no params. */
function canonicalPaths(): string[] {
  const routes = join(SRC, "routes");
  return readdirSync(routes)
    .filter((name) => name.endsWith(".tsx"))
    .flatMap((name) => [
      ...readFileSync(join(routes, name), "utf8").matchAll(/canonical\("(\/[^"]*)"\)/g),
    ])
    .map((m) => m[1] as string);
}

/** The doc pages, `/docs/<slug>` for each page in `docs/` but its index. */
function docPaths(): string[] {
  return readdirSync(join(SRC, "../../../docs"))
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .map((name) => `/docs/${name.slice(0, -3)}`);
}

describe("sitemap.xml", () => {
  it("lists every public page and doc page, once, at the site's origin", () => {
    const expected = [...new Set([...canonicalPaths(), ...docPaths()])].map(
      (path) => new URL(path, SITE_URL).href,
    );
    expect(expected).toEqual(expect.arrayContaining([`${SITE_URL}/terms`, `${SITE_URL}/privacy`]));
    expect([...listed].sort()).toEqual(expected.sort());
  });
});
