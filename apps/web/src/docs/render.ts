import { posix } from "node:path";
import MarkdownIt, { type Token } from "markdown-it";

/** One page of `docs/`, rendered at build time. */
export interface DocPage {
  /** URL segment under `/docs`; `""` for `README.md`, the docs index. */
  readonly slug: string;
  /** Text of the first `#` heading. */
  readonly title: string;
  readonly html: string;
  /** Heading ids in the page, for `#anchor` links. */
  readonly anchors: readonly string[];
}

export interface RenderOptions {
  /** File names of all pages in `docs/`, to tell page links from links to other repo files. */
  readonly pages: readonly string[];
  /** Repository files outside `docs/` link here: `<repoUrl>/blob/<branch>/<path>`. */
  readonly repoUrl: string;
  readonly branch: string;
}

/** `rules.md` → `rules`; `README.md` → `""`. */
export function docSlug(file: string): string {
  return file === "README.md" ? "" : file.replace(/\.md$/, "");
}

/** The site path of a page. */
export function docPath(slug: string): string {
  return slug ? `/docs/${slug}` : "/docs";
}

/**
 * Renders a `docs/*.md` page to HTML. Raw HTML in the Markdown is escaped, never passed through
 * (`html: false`), and markdown-it drops `javascript:`/`vbscript:`/`file:`/`data:` link targets,
 * so the output is safe to inject. Headings get GitHub's ids, so `page.md#anchor` links written
 * for GitHub keep working; links to other pages become site links, links to other repository files
 * point at GitHub.
 */
export function renderDoc(file: string, markdown: string, options: RenderOptions): DocPage {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
  const anchors: string[] = [];
  let title = "";

  md.core.ruler.push("zerosnake_docs", (state) => {
    const seen = new Map<string, number>();
    state.tokens.forEach((token, i) => {
      if (token.type === "heading_open") {
        const text = plainText(state.tokens[i + 1]?.children ?? []);
        if (!title && token.tag === "h1") title = text;
        const base = githubSlug(text);
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        const id = n === 0 ? base : `${base}-${n}`;
        token.attrSet("id", id);
        anchors.push(id);
      }
      for (const child of token.children ?? []) {
        if (child.type === "link_open") {
          const href = child.attrGet("href");
          if (href === null) continue;
          const to = rewriteHref(String(href), options);
          child.attrSet("href", to);
          if (/^https?:/.test(to)) child.attrSet("rel", "noreferrer");
        } else if (child.type === "image") {
          const src = child.attrGet("src");
          if (src !== null) child.attrSet("src", rewriteHref(String(src), options, "raw"));
        }
      }
    });
  });

  // Wide tables scroll on their own instead of the page.
  md.renderer.rules.table_open = () => '<div class="table-scroll"><table class="table">\n';
  md.renderer.rules.table_close = () => "</table></div>\n";

  const html = md.render(markdown);
  return { slug: docSlug(file), title: title || docSlug(file), html, anchors };
}

/** GitHub's heading ids: lowercase, punctuation dropped, whitespace to `-`. */
export function githubSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function plainText(tokens: readonly Token[]): string {
  return tokens
    .filter((t) => t.type === "text" || t.type === "code_inline")
    .map((t) => t.content)
    .join("");
}

const SCHEME = /^[a-z][a-z\d+.-]*:/i;

/** A link target as written in `docs/` → where it goes on the site. */
function rewriteHref(href: string, options: RenderOptions, kind: "blob" | "raw" = "blob"): string {
  if (href === "" || href.startsWith("#") || href.startsWith("/") || SCHEME.test(href)) {
    return href;
  }
  const hashAt = href.indexOf("#");
  const path = hashAt < 0 ? href : href.slice(0, hashAt);
  const hash = hashAt < 0 ? "" : href.slice(hashAt);
  const resolved = posix.normalize(posix.join("docs", path)).replace(/\/$/, "");
  const page = resolved.startsWith("docs/") ? resolved.slice("docs/".length) : undefined;
  if (page && options.pages.includes(page)) return docPath(docSlug(page)) + hash;
  if (resolved.startsWith("..")) return href;
  return `${options.repoUrl}/${kind}/${options.branch}/${resolved}${hash}`;
}
