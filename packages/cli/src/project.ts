import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CliError } from "./errors.ts";
import { readJson } from "./paths.ts";

/** Where the bot lives when `--bot` isn't given, in order. */
export const ENTRY_CANDIDATES = ["src/bot.ts", "src/bot.js", "src/index.ts", "src/index.js"];

export interface Project {
  /** The nearest folder with a package.json or a bot entry (or `cwd` without either). */
  root: string;
  /** Its package name, else the folder name. */
  name: string;
}

export function findProject(cwd: string): Project {
  let dir = resolve(cwd);
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const name = readJson(manifest).name;
      return { root: dir, name: typeof name === "string" && name ? name : basename(dir) };
    }
    if (ENTRY_CANDIDATES.some((c) => existsSync(join(dir, c)))) {
      return { root: dir, name: basename(dir) };
    }
    const parent = dirname(dir);
    if (parent === dir) return { root: resolve(cwd), name: basename(resolve(cwd)) };
    dir = parent;
  }
}

/** The bot's entry file: `explicit` (relative to `cwd`) or the first of {@link ENTRY_CANDIDATES}. */
export function findEntry(project: Project, cwd: string, explicit?: string): string {
  if (explicit !== undefined) {
    const file = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
    if (!existsSync(file)) throw new CliError(`Bot file not found: ${explicit}`);
    return file;
  }
  for (const candidate of ENTRY_CANDIDATES) {
    const file = join(project.root, candidate);
    if (existsSync(file)) return file;
  }
  throw new CliError(
    `No bot found in ${relative(cwd, project.root) || "."}: expected ${ENTRY_CANDIDATES[0]}.\n` +
      "Start a project with `npx zerosnake init my-snake`, or point at a file with --bot <file>.",
  );
}

/** A file of the project's sources, as the deploy limits count them. */
export interface SourceFile {
  /** Relative to the project root, `/`-separated. */
  path: string;
  bytes: number;
}

/** Everything under `src/` but hidden files like `.DS_Store` (what `deploy` uploads). */
export function collectSources(root: string): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        out.push({ path: relative(root, file).split("\\").join("/"), bytes: statSync(file).size });
      }
    }
  };
  walk(join(root, "src"));
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
