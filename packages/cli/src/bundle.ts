import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { checkSource } from "@zerosnake/sandbox";
import { build, formatMessages, type Loader, type Message, type Plugin } from "esbuild";
import { sdkEntry } from "./assets.ts";
import { CliError } from "./errors.ts";
import { originalPosition, type SourceMap } from "./sourcemap.ts";

export interface BundleOptions {
  /** Folder that error messages and `inputs` are relative to. Default: `process.cwd()`. */
  cwd?: string;
  /** Colour in error messages. Default: off. */
  color?: boolean;
}

export interface BundledBot {
  /** One ESM file, SDK included, that default-exports the bot. What the sandbox and deploy get. */
  code: string;
  /** UTF-8 size of `code`. */
  bytes: number;
  /** The project's own files that went into it (no packages), relative to `cwd`. */
  inputs: string[];
}

const OUTFILE = "bot.js";

/**
 * Bundles a bot into the single ESM file the sandbox runs (SPEC §6), the same way for `sim`,
 * `test` and `deploy`. Throws a {@link CliError} a person can act on: esbuild's errors with
 * `file:line:column`, a missing default export, or syntax the sandbox refuses (BigInt literals,
 * `async`; checked on the bundle, like the server) traced back to the author's file and line.
 *
 * `@zerosnake/sdk` resolves from the project when it is installed there, and falls back to the
 * CLI's own copy otherwise, so a fresh `zerosnake init` can `sim` before any `npm install`.
 *
 * The same sources give the same bytes on any machine and in any folder (see {@link stableNames}):
 * the check seeds come from the bundle's hash, so `test` here and the server must agree.
 */
export async function bundleBot(entry: string, options: BundleOptions = {}): Promise<BundledBot> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const file = isAbsolute(entry) ? entry : join(cwd, entry);
  const shown = relative(cwd, file) || file;

  let result: Awaited<ReturnType<typeof bundle>>;
  try {
    result = await bundle(file, cwd);
  } catch (e) {
    const errors = (e as { errors?: Message[] }).errors;
    if (!errors) throw e;
    const text = await formatMessages(errors, { kind: "error", color: options.color ?? false });
    const count = errors.length === 1 ? "1 error" : `${errors.length} errors`;
    throw new CliError(`Couldn't bundle ${shown} (${count}):\n\n${text.join("").trimEnd()}`);
  }

  const code = result.outputFiles?.find((f) => f.path.endsWith(OUTFILE))?.text ?? "";
  const map = result.outputFiles?.find((f) => f.path.endsWith(`${OUTFILE}.map`))?.text;
  const output = result.metafile?.outputs[OUTFILE];
  const inputs = Object.keys(result.metafile?.inputs ?? {})
    .filter((p) => !p.startsWith(`${PACKAGE_NAMESPACE}:`))
    .map((p) => relative(cwd, resolve(cwd, p)))
    .filter((p) => !p.startsWith("..") && !p.split(/[\\/]/).includes("node_modules"))
    .map((p) => p.split(sep).join("/"));

  if (!output?.exports.includes("default")) {
    throw new CliError(
      `${shown} has no default export. The sandbox loads the bot from it, so end the file with:\n\n` +
        `  export default defineBot({\n    tick(state) {\n      return { turn: 0 };\n    },\n  });`,
    );
  }

  // The same check the sandbox (and the deploy checks) run on the bundle: comments are gone by
  // now, so a comment saying "async" doesn't count. Point at the author's line when we can.
  const problem = checkSource(code);
  if (problem) throw new CliError(locate(problem, map, shown));

  return { code, bytes: Buffer.byteLength(code), inputs };
}

/** `checkSource` reports bundle lines; map them back to the file and line they came from. */
function locate(problem: string, map: string | undefined, entry: string): string {
  const at = / on line (\d+)\)$/.exec(problem);
  const position = at && map ? originalPosition(JSON.parse(map) as SourceMap, Number(at[1])) : null;
  if (!at || !position) return `The bundle of ${entry}: ${problem}`;
  return `${position.source}:${position.line}: ${problem.slice(0, at.index)})`;
}

function bundle(file: string, cwd: string) {
  return build({
    entryPoints: [file],
    absWorkingDir: cwd,
    outfile: OUTFILE,
    bundle: true,
    write: false,
    metafile: true,
    // Only to map the sandbox's syntax checks back to sources; not part of the bundle.
    sourcemap: "external",
    format: "esm",
    // QuickJS: no Node or browser APIs, ES2023 syntax.
    platform: "neutral",
    target: "es2023",
    mainFields: ["module", "main"],
    logLevel: "silent",
    plugins: [stableNames(cwd)],
  });
}

/** esbuild namespace of files that belong to a package: `pkg:<name>@<version>/<file>`. */
const PACKAGE_NAMESPACE = "pkg";

/** `pluginData` of our own `build.resolve` calls, so the plugin doesn't resolve them again. */
const NESTED = Symbol("nested");

/**
 * Names every module the same wherever it is installed. esbuild writes each module's path into
 * the bundle (a `// path` comment above its code, the key of a CommonJS wrapper), relative to the
 * project. For the CLI's own copy of the SDK, that path climbed out of the project to wherever
 * the CLI lives, so the same bot gave other bytes, and other check seeds, on another machine
 * or checkout. Now the project's files keep their relative paths, and a package's files are
 * named `<name>@<version>/<file in the package>`: the same in `node_modules` (npm or pnpm), in
 * a vendored or linked copy, and in the CLI.
 *
 * Also resolves `@zerosnake/sdk` from the project, else from the CLI.
 */
function stableNames(root: string): Plugin {
  const packages = new Map<string, { id: string; dir: string } | null>();
  return {
    name: "zerosnake-stable-names",
    setup(b) {
      b.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData === NESTED || args.kind === "entry-point") return undefined;
        const found = await b.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          namespace: "file",
          resolveDir: args.resolveDir,
          pluginData: NESTED,
        });
        let path = found.path;
        if (found.errors.length > 0) {
          // Let esbuild report it, with the importing line.
          if (args.path !== "@zerosnake/sdk") return undefined;
          path = sdkEntry();
        } else if (found.namespace !== "file" || !isAbsolute(path)) {
          return found;
        }
        const pkg = packageOf(path, root, packages);
        if (!pkg) return { path, sideEffects: found.sideEffects };
        return {
          path: `${pkg.id}/${relative(pkg.dir, path).split(sep).join("/")}`,
          namespace: PACKAGE_NAMESPACE,
          pluginData: path,
          sideEffects: found.sideEffects,
        };
      });
      b.onLoad({ filter: /.*/, namespace: PACKAGE_NAMESPACE }, async (args) => {
        const file = args.pluginData as string;
        return {
          contents: await readFile(file),
          loader: loaderOf(file),
          resolveDir: dirname(file),
        };
      });
    },
  };
}

/**
 * The package a file belongs to: the nearest `package.json` above it with a name, as
 * `name@version`. `null` for the project's own files (inside `root`, not in a package of its own)
 * and for files outside any package.
 */
function packageOf(
  file: string,
  root: string,
  cache: Map<string, { id: string; dir: string } | null>,
): { id: string; dir: string } | null {
  const seen: string[] = [];
  let found: { id: string; dir: string } | null = null;
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const known = cache.get(dir);
    if (known !== undefined) {
      found = known;
      break;
    }
    seen.push(dir);
    if (dir === root) break;
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const { name, version } = JSON.parse(readFileSync(manifest, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (name) {
        found = { id: `${name}@${version ?? "0.0.0"}`, dir };
        break;
      }
    }
    if (dirname(dir) === dir) break;
  }
  for (const dir of seen) cache.set(dir, found);
  return found;
}

const LOADERS: Record<string, Loader> = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".jsx": "jsx",
  ".json": "json",
};

function loaderOf(file: string): Loader {
  return LOADERS[extname(file)] ?? "js";
}
