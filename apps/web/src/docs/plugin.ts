import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { REPO } from "../site.ts";
import { renderDoc } from "./render.ts";

const ID = "virtual:zerosnake-docs";
const RESOLVED = `\0${ID}`;

/**
 * Serves `docs/*.md` rendered at build time:
 *
 * - `virtual:zerosnake-docs`: `DOCS` (slug and title of every page, the index first) and
 *   `loadDoc(slug)`, which imports one page;
 * - `virtual:zerosnake-docs/<file>`: that page's `DocPage`, its own chunk.
 *
 * The Markdown parser runs here only; the site ships finished HTML.
 */
export function docsPlugin(dir: string): Plugin {
  const files = () =>
    readingOrder(
      dir,
      readdirSync(dir).filter((f) => f.endsWith(".md")),
    );
  const render = (file: string) =>
    renderDoc(file, readFileSync(join(dir, file), "utf8"), {
      pages: files(),
      repoUrl: REPO.url,
      branch: REPO.branch,
    });

  return {
    name: "zerosnake-docs",
    resolveId(id) {
      return id === ID || id.startsWith(`${ID}/`) ? `\0${id}` : undefined;
    },
    load(id) {
      if (id === RESOLVED) {
        const pages = files().map((file) => {
          const { slug, title } = render(file);
          this.addWatchFile(join(dir, file));
          return { file, slug, title };
        });
        const loaders = pages
          .map(
            (p) =>
              `  ${JSON.stringify(p.slug)}: () => import(${JSON.stringify(`${ID}/${p.file}`)}),`,
          )
          .join("\n");
        return [
          `export const DOCS = ${JSON.stringify(pages.map(({ slug, title }) => ({ slug, title })))};`,
          `const loaders = {\n${loaders}\n};`,
          "export async function loadDoc(slug) {",
          "  const load = Object.hasOwn(loaders, slug) ? loaders[slug] : undefined;",
          "  return load ? (await load()).default : undefined;",
          "}",
        ].join("\n");
      }
      if (id.startsWith(`${RESOLVED}/`)) {
        const file = id.slice(RESOLVED.length + 1);
        if (!files().includes(file)) return undefined;
        this.addWatchFile(join(dir, file));
        return `export default ${JSON.stringify(render(file))};`;
      }
      return undefined;
    },
  };
}

/** README first, then the pages in the order README links them, then any others by name. */
function readingOrder(dir: string, files: readonly string[]): string[] {
  const readme = files.includes("README.md") ? readFileSync(join(dir, "README.md"), "utf8") : "";
  const linked = [...readme.matchAll(/\]\(([\w-]+\.md)[)#]/g)].map((m) => m[1] as string);
  const rank = (f: string) => {
    if (f === "README.md") return -1;
    const i = linked.indexOf(f);
    return i < 0 ? linked.length : i;
  };
  return [...files].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
