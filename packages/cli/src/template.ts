import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

// Node built-ins only: scripts/build.ts imports this file before anything is bundled.

/** Never copied out of a template: installs, build output, caches, OS junk, maintainer docs. */
const SKIP = new Set([
  "MAINTAINING.md",
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
 * Copies the SDK's TypeScript sources (`src/*.ts`, no tests) and a minimal `package.json` that
 * exports them. Used for `dist/sdk` and for the copy `init` puts in a new project.
 */
export function copySdk(from: string, to: string, description: string): string[] {
  const pkg = JSON.parse(readFileSync(join(from, "package.json"), "utf8")) as { version: string };
  mkdirSync(join(to, "src"), { recursive: true });
  const files = ["package.json"];
  for (const name of readdirSync(join(from, "src")).sort()) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    copyFileSync(join(from, "src", name), join(to, "src", name));
    files.push(`src/${name}`);
  }
  const manifest = {
    name: "@zerosnake/sdk",
    version: pkg.version,
    private: true,
    description,
    type: "module",
    exports: "./src/index.ts",
  };
  writeFileSync(join(to, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return files;
}
