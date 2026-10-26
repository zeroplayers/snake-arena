/**
 * Builds the publishable CLI into `dist/` (`prepack` runs it; `pnpm --filter zerosnake build`
 * by hand). Nothing in `dist/` refers to the monorepo:
 * - `cli.js`: the CLI and every workspace package it uses, bundled. Only the npm packages in
 *   `dependencies` stay external (esbuild and QuickJS load native or wasm files next to
 *   themselves);
 * - `client.js`: the `sim` viewer page (viewer, renderer, three.js), prebuilt;
 * - `house/<name>.js`: the house bots as sandbox bundles;
 * - `sdk/`: the SDK's TypeScript sources, for bundling bots without an install and for `init`;
 * - `template/`: a copy of the repo's `template/`, so `init` works offline.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { bundleHouseBot, HOUSE_BOTS } from "../src/house.ts";
import { ownPackageDir } from "../src/paths.ts";
import { clientBuildOptions } from "../src/sim/server.ts";
import { copySdk, copyTemplate } from "../src/template.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

export async function buildCli(): Promise<void> {
  const dist = join(root, "dist");
  rmSync(dist, { recursive: true, force: true });
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };

  await Promise.all([
    build({
      entryPoints: [join(root, "src", "cli.ts")],
      outfile: join(dist, "cli.js"),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
      external: Object.keys(pkg.dependencies),
      // Switches src/assets.ts to the files below.
      define: { ZEROSNAKE_BUNDLED: "true" },
      logLevel: "warning",
    }),
    build({ ...clientBuildOptions(), outfile: join(dist, "client.js"), logLevel: "warning" }),
    ...HOUSE_BOTS.map(async (name) => {
      mkdirSync(join(dist, "house"), { recursive: true });
      writeFileSync(join(dist, "house", `${name}.js`), await bundleHouseBot(name));
    }),
  ]);
  copySdk(ownPackageDir("@zerosnake/sdk"), join(dist, "sdk"), "The SDK bundled with the CLI.");
  copyTemplate(join(root, "..", "..", "template"), join(dist, "template"));
}

if (import.meta.main) await buildCli();
