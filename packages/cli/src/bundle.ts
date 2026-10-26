import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { checkSource } from "@zerosnake/sandbox";
import { build, formatMessages, type Message, type Plugin } from "esbuild";
import { CliError } from "./errors.ts";
import { resolveOwn } from "./paths.ts";

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
 * `async`) located in the author's own file.
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

  const code = result.outputFiles?.[0]?.text ?? "";
  const output = result.metafile?.outputs[OUTFILE];
  const inputs = Object.keys(result.metafile?.inputs ?? {})
    .map((p) => resolve(cwd, p))
    .filter((p) => !p.includes("/node_modules/") && !relative(cwd, p).startsWith(".."))
    .map((p) => relative(cwd, p));

  if (!output?.exports.includes("default")) {
    throw new CliError(
      `${shown} has no default export. The sandbox loads the bot from it, so end the file with:\n\n` +
        `  export default defineBot({\n    tick(state) {\n      return { turn: 0 };\n    },\n  });`,
    );
  }

  // The sandbox checks the bundle too, but only knows bundle line numbers: point at the source.
  for (const input of inputs) {
    const problem = checkSource(readFileSync(join(cwd, input), "utf8"));
    if (problem) throw new CliError(`${input}: ${problem}`);
  }
  const problem = checkSource(code);
  if (problem) throw new CliError(`The bundle of ${shown} (from a dependency): ${problem}`);

  return { code, bytes: Buffer.byteLength(code), inputs };
}

function bundle(file: string, cwd: string) {
  return build({
    entryPoints: [file],
    absWorkingDir: cwd,
    outfile: OUTFILE,
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    // QuickJS: no Node or browser APIs, ES2023 syntax.
    platform: "neutral",
    target: "es2023",
    mainFields: ["module", "main"],
    logLevel: "silent",
    plugins: [sdkFallback],
  });
}

const SDK = "@zerosnake/sdk";

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
      return { path: resolveOwn(SDK) };
    });
  },
};
