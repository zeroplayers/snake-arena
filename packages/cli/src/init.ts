import { existsSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { CliError } from "./errors.ts";
import { ownPackageDir, packageRoot, readJson } from "./paths.ts";
import { copyTemplate, findTemplateDir } from "./template.ts";

export interface InitOptions {
  /** Template folder. Default: the one bundled with the CLI. */
  templateDir?: string;
  cwd?: string;
}

export interface InitResult {
  /** Absolute path of the new project. */
  dir: string;
  /** Package name written to its package.json. */
  name: string;
  /** Files created, relative to `dir`. */
  files: string[];
}

/** Ignorable leftovers that don't make a folder "not empty". */
const HARMLESS = new Set([".git", ".DS_Store", "Thumbs.db"]);

/**
 * `zerosnake init <dir>`: copies the bot template into a new (or empty) folder. Works offline:
 * the template ships inside the CLI. Dependencies the template takes from the monorepo
 * (`workspace:*`) become ordinary version ranges.
 */
export function initProject(target: string, options: InitOptions = {}): InitResult {
  const dir = resolve(options.cwd ?? process.cwd(), target);
  if (existsSync(dir)) {
    const leftovers = readdirSync(dir).filter((f) => !HARMLESS.has(f));
    if (leftovers.length > 0) {
      throw new CliError(
        `${target} already exists and isn't empty. Pick a new folder name, e.g. zerosnake init my-snake`,
      );
    }
  }
  const files = copyTemplate(options.templateDir ?? findTemplateDir(packageRoot()), dir);

  // npm drops .gitignore files from published packages, so templates often ship it renamed.
  for (const alias of ["gitignore", "_gitignore"]) {
    if (files.includes(alias) && !existsSync(join(dir, ".gitignore"))) {
      renameSync(join(dir, alias), join(dir, ".gitignore"));
      files[files.indexOf(alias)] = ".gitignore";
    }
  }
  if (!existsSync(join(dir, ".gitignore"))) {
    writeFileSync(join(dir, ".gitignore"), "node_modules/\ndist/\n");
    files.push(".gitignore");
  }

  const name = packageName(basename(dir));
  const manifest = join(dir, "package.json");
  if (existsSync(manifest)) {
    const pkg = readJson(manifest);
    pkg.name = name;
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      const deps = pkg[field] as Record<string, string> | undefined;
      if (!deps) continue;
      for (const [dep, range] of Object.entries(deps)) {
        if (range.startsWith("workspace:")) deps[dep] = publishedRange(dep);
      }
    }
    writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  return { dir, name, files: files.sort() };
}

/** A valid npm package name from a folder name. */
export function packageName(folder: string): string {
  const name = folder
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return name || "zerosnake-bot";
}

/** `^x.y.z` of a workspace package, as the CLI knows it; `*` when it doesn't. */
function publishedRange(dep: string): string {
  try {
    const dir = dep === "zerosnake" ? packageRoot() : ownPackageDir(dep);
    return `^${String(readJson(join(dir, "package.json")).version)}`;
  } catch {
    return "*";
  }
}
