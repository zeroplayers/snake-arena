import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

// Node built-ins only: scripts/build.ts imports this file before anything is bundled.

/** Never copied out of a template: installs, build output, caches, OS junk. */
const SKIP = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".turbo",
  ".wrangler",
  ".zerosnake",
  ".DS_Store",
]);

function skipped(name: string): boolean {
  return SKIP.has(name) || name.endsWith(".tsbuildinfo") || name.endsWith(".log");
}

/**
 * Copies a template folder, whatever is in it, minus {@link SKIP}. Returns the copied files
 * relative to `to`, sorted.
 */
export function copyTemplate(from: string, to: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skipped(entry.name)) continue;
      const src = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(src);
      } else if (entry.isFile()) {
        const dest = join(to, relative(from, src));
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(src, dest);
        files.push(relative(to, dest));
      }
    }
  };
  walk(from);
  return files.sort();
}

/**
 * The bot template: the copy bundled into the CLI (`dist/template`, made by `pnpm build`) or,
 * in a checkout of the monorepo, `template/` itself.
 */
export function findTemplateDir(packageRoot: string): string {
  const candidates = [
    join(packageRoot, "dist", "template"),
    join(packageRoot, "..", "..", "template"),
  ];
  const found = candidates.find((dir) => existsSync(join(dir, "package.json")) || hasFiles(dir));
  if (!found) {
    throw new Error(`zerosnake: the bot template is missing (looked in ${candidates.join(", ")})`);
  }
  return found;
}

function hasFiles(dir: string): boolean {
  return existsSync(dir) && readdirSync(dir).some((name) => !skipped(name));
}
