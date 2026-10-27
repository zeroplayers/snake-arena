import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/**
 * The `zerosnake` package's own folder. Found by walking up from this module, so it is the same
 * whether the CLI runs from `src/` (tests) or from the bundled `dist/cli.js`.
 */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && readJson(manifest).name === "zerosnake") return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("zerosnake: can't find the CLI's package.json");
    dir = parent;
  }
}

/** Entry file of a package the CLI depends on, resolved from the CLI (not the user's project). */
export function resolveOwn(specifier: string): string {
  return require.resolve(specifier);
}

/** Folder of a dependency's `package.json` (our workspace packages don't export it). */
export function ownPackageDir(name: string): string {
  let dir = dirname(resolveOwn(name));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && readJson(manifest).name === name) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`zerosnake: can't find the package.json of ${name}`);
    dir = parent;
  }
}

export function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}
