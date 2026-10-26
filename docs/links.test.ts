import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Keeps the docs from rotting: every relative link in them must point at a file or folder that
 * exists (and at a heading that exists, for `page.md#anchor`), and every repository path they
 * mention in backticks (`packages/engine/src/config.ts`) must exist too.
 */

const DOCS = import.meta.dirname;
const ROOT = resolve(DOCS, "..");

/** The pages checked: everything in docs/ plus the repository files that link into it. */
const PAGES = [
  ...readdirSync(DOCS)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(DOCS, f)),
  join(ROOT, "CONTRIBUTING.md"),
];

/** Backticked text that starts like this is taken as a path from the repository root. */
const REPO_PATH = /^(?:packages|apps|bots|template|docs|spikes|\.github)\/[\w.@$/-]*$/;

/**
 * Paths that exist only in open pull requests, by path prefix → PR number. The docs mention them
 * as "in review". When a PR merges, link the files and drop its entry.
 */
const PENDING: Readonly<Record<string, number>> = {
  "packages/rating/": 51,
  "apps/web/src/shared/": 52,
  "packages/checks/": 54,
};

interface Problem {
  page: string;
  line: number;
  message: string;
}

/** The page without fenced code blocks (replaced by blank lines, so line numbers hold). */
function prose(text: string): string {
  return text.replace(/^```[^\n]*\n[\s\S]*?^```$/gm, (block) => block.replace(/[^\n]/g, ""));
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** GitHub's heading anchors: lowercase, punctuation dropped, spaces to `-`, repeats get `-1`, … */
function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const match of prose(markdown).matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const base = (match[1] as string)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

function pending(path: string): number | undefined {
  for (const [prefix, pr] of Object.entries(PENDING)) if (`${path}/`.startsWith(prefix)) return pr;
  return undefined;
}

function checkPage(file: string): { problems: Problem[]; links: number; paths: number } {
  const page = relative(ROOT, file);
  const text = prose(readFileSync(file, "utf8"));
  const problems: Problem[] = [];
  const report = (index: number, message: string) =>
    problems.push({ page, line: lineAt(text, index), message });

  let links = 0;
  for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1] as string;
    if (/^[a-z][a-z+.-]*:/i.test(target)) continue; // https:, mailto:, …
    links++;
    const [path = "", anchor] = target.split("#", 2);
    const resolved = path === "" ? file : resolve(dirname(file), decodeURIComponent(path));
    if (!existsSync(resolved)) {
      report(match.index, `broken link: ${target}`);
      continue;
    }
    if (anchor !== undefined && resolved.endsWith(".md")) {
      if (!headingAnchors(readFileSync(resolved, "utf8")).has(anchor)) {
        report(match.index, `no heading for #${anchor} in ${relative(ROOT, resolved)}`);
      }
    }
  }

  let paths = 0;
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const path = (match[1] as string).replace(/\/$/, "");
    if (!REPO_PATH.test(path)) continue;
    paths++;
    if (existsSync(join(ROOT, path))) continue;
    if (pending(path) !== undefined) continue;
    report(match.index, `no such path in the repository: ${path}`);
  }

  return { problems, links, paths };
}

describe("docs", () => {
  for (const file of PAGES) {
    it(`${relative(ROOT, file)}: links and source paths exist`, () => {
      const { problems } = checkPage(file);
      expect(problems.map((p) => `${p.page}:${p.line}: ${p.message}`)).toEqual([]);
    });
  }

  it("checks something", () => {
    const totals = PAGES.map(checkPage);
    expect(totals.reduce((n, t) => n + t.links, 0)).toBeGreaterThan(50);
    expect(totals.reduce((n, t) => n + t.paths, 0)).toBeGreaterThan(5);
  });

  it("lists pending paths only while they are missing", () => {
    const merged = Object.keys(PENDING).filter((prefix) => existsSync(join(ROOT, prefix)));
    // Not a failure: another PR merging must not turn main red. It's the cue to update the docs.
    if (merged.length > 0) {
      console.warn(`docs: these PENDING paths exist now; link them and drop them: ${merged}`);
    }
  });
});

describe("headingAnchors", () => {
  it("matches GitHub's anchors", () => {
    const anchors = headingAnchors(
      "# Turn quantization (1/128)\n## `snakes[]` (`SnakeView`)\n## Why it doesn't help\n## A\n## A\n```\n# not a heading\n```\n",
    );
    expect([...anchors]).toEqual([
      "turn-quantization-1128",
      "snakes-snakeview",
      "why-it-doesnt-help",
      "a",
      "a-1",
    ]);
  });
});
