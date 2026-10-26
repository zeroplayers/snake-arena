/**
 * Builds the runnable CLI into `dist/`:
 * - `dist/cli.js`: the CLI and the workspace packages it uses (TypeScript sources) in one ESM
 *   file. esbuild and QuickJS stay external: they load native and wasm files next to themselves.
 * - `dist/template/`: a copy of the repo's `template/`, so `zerosnake init` works offline.
 *
 * `bin/zerosnake.js` runs this before every command in a checkout of the monorepo (~0.1 s), so
 * the CLI there is never stale. `pnpm --filter zerosnake build` runs it by hand.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { copyTemplate } from "../src/template.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

export const EXTERNAL = [
  "esbuild",
  "@jitl/quickjs-wasmfile-release-sync",
  "quickjs-emscripten-core",
];

export async function buildCli(): Promise<void> {
  const dist = join(root, "dist");
  rmSync(join(dist, "template"), { recursive: true, force: true });
  copyTemplate(join(root, "..", "..", "template"), join(dist, "template"));
  await build({
    entryPoints: [join(root, "src", "cli.ts")],
    outfile: join(dist, "cli.js"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    external: EXTERNAL,
    logLevel: "warning",
  });
}

if (import.meta.main) await buildCli();
