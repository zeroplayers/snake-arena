import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { checkSource } from "@zerosnake/sandbox";
import { build, formatMessages, type Message, type Plugin } from "esbuild";
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
  /** The project's own files that went into it (no `node_modules`), relative to `cwd`. */
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
    plugins: [sdkFallback],
  });
}

/** Resolves `@zerosnake/sdk` from the project, else from the CLI. */
const sdkFallback: Plugin = {
  name: "zerosnake-sdk-fallback",
  setup(b) {
    b.onResolve({ filter: /^@zerosnake\/sdk$/ }, async (args) => {
      if (args.pluginData === sdkFallback) return undefined;
      const found = await b.resolve(args.path, {
        kind: args.kind,
        importer: args.importer,
        resolveDir: args.resolveDir,
        pluginData: sdkFallback,
      });
      if (found.errors.length === 0) {
        return { path: found.path, namespace: found.namespace, sideEffects: found.sideEffects };
      }
      return { path: sdkEntry() };
    });
  },
};
