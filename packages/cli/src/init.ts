import { existsSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { sdkDir, templateDir } from "./assets.ts";
import { CliError } from "./errors.ts";
import { ownPackageDir, packageRoot, readJson } from "./paths.ts";
import { copySdk, copyTemplate } from "./template.ts";

const SDK_NOTE =
  "The ZeroSnake SDK, copied here by `zerosnake init` until @zerosnake/sdk is on npm. " +
  "Replace it with the npm package then.";

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
  /** Template dependencies left out of package.json because they aren't on npm yet. */
  omitted: string[];
}

/**
 * Workspace packages that are on npm, which `init` refers to as `^version`. Empty until the
 * launch (zeroplayers/snake-arena#31); add each one as it is published.
 */
export const PUBLISHED: ReadonlySet<string> = new Set<string>();

/** Where `init` puts its copy of the SDK while the SDK isn't on npm. */
export const VENDORED_SDK = "vendor/zerosnake-sdk";

/** Ignorable leftovers that don't make a folder "not empty". */
const HARMLESS = new Set([".git", ".DS_Store", "Thumbs.db"]);

/**
 * `zerosnake init <dir>`: copies the bot template into a new (or empty) folder. Works offline:
 * the template ships inside the CLI. Its monorepo dependencies (`workspace:*`) become:
 * - `^version` for packages on npm ({@link PUBLISHED});
 * - for `@zerosnake/sdk` until then, a copy of the SDK in {@link VENDORED_SDK} referenced as a
 *   `file:` dependency, so `npm install` works and editors see the types;
 * - nothing for the rest (engine, sandbox, house bots: only the template's own tests use them),
 *   listed in `omitted` so the caller can say so.
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
  const from = options.templateDir ?? templateDir();
  if (!existsSync(from)) throw new Error(`zerosnake: the bot template is missing (${from})`);
  const files = copyTemplate(from, dir);
  const omitted: string[] = [];

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
        if (!range.startsWith("workspace:")) continue;
        if (PUBLISHED.has(dep)) {
          deps[dep] = publishedRange(dep);
        } else if (dep === "@zerosnake/sdk") {
          const vendored = copySdk(sdkDir(), join(dir, VENDORED_SDK), SDK_NOTE);
          files.push(...vendored.map((f) => `${VENDORED_SDK}/${f}`));
          deps[dep] = `file:${VENDORED_SDK}`;
        } else {
          delete deps[dep];
          omitted.push(dep);
        }
      }
    }
    writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  return { dir, name, files: files.sort(), omitted: omitted.sort() };
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
