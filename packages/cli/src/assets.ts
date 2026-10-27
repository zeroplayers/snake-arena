import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ownPackageDir, packageRoot } from "./paths.ts";

/**
 * Where the CLI's assets come from. The published CLI is `dist/` only (`scripts/build.ts`, run
 * by `prepack`): one `cli.js` plus prebuilt files next to it. Running from source (tests, the
 * monorepo) the same assets come from the workspace instead.
 *
 * | asset            | dist/              | source                                  |
 * | ---------------- | ------------------ | --------------------------------------- |
 * | viewer page      | `client.js`        | `src/sim/client.ts`, bundled on demand  |
 * | house bots       | `house/<name>.js`  | `@zerosnake/house-bots`, bundled        |
 * | SDK (TS sources) | `sdk/`             | `packages/sdk`                          |
 * | bot template     | `template/`        | the repo's `template/`                  |
 */

// `scripts/build.ts` defines it as `true` in dist/cli.js; it doesn't exist anywhere else.
declare const ZEROSNAKE_BUNDLED: boolean | undefined;

export const BUNDLED = typeof ZEROSNAKE_BUNDLED !== "undefined" && ZEROSNAKE_BUNDLED;

/** `dist/` when bundled (the folder of `cli.js`). */
function distDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** Prebuilt file in `dist/`, read as text. Only call when {@link BUNDLED}. */
export function distFile(path: string): string {
  return readFileSync(join(distDir(), path), "utf8");
}

/** The SDK package folder: `package.json` and `src/*.ts` (TypeScript sources, no tests). */
export function sdkDir(): string {
  return BUNDLED ? join(distDir(), "sdk") : ownPackageDir("@zerosnake/sdk");
}

/** The SDK's entry, for bundling bots in projects that don't have it installed. */
export function sdkEntry(): string {
  return join(sdkDir(), "src", "index.ts");
}

/** The bot template folder. */
export function templateDir(): string {
  return BUNDLED ? join(distDir(), "template") : join(packageRoot(), "..", "..", "template");
}
