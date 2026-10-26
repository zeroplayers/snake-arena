import { dirname } from "node:path";
import { build } from "esbuild";
import { BUNDLED, distFile } from "./assets.ts";
import { resolveOwn } from "./paths.ts";

/** House bots `--vs` accepts by name, weakest first (`chaos` is random, not ranked). */
export const HOUSE_BOTS = ["easy", "medium", "hard", "chaos"] as const;
export type HouseBotName = (typeof HOUSE_BOTS)[number];

export function isHouseBot(name: string): name is HouseBotName {
  return (HOUSE_BOTS as readonly string[]).includes(name);
}

const cache = new Map<HouseBotName, Promise<string>>();

/**
 * A house bot as a sandbox bundle, the way the arena runs it. House bots are named exports of
 * `@zerosnake/house-bots`, so the bundle is a one-line entry that re-exports one as the default,
 * exactly like a user bot. Prebuilt in `dist/house/` for the published CLI.
 */
export function houseBotBundle(name: HouseBotName): Promise<string> {
  let bundle = cache.get(name);
  if (!bundle) {
    bundle = BUNDLED ? Promise.resolve(distFile(`house/${name}.js`)) : bundleHouseBot(name);
    cache.set(name, bundle);
  }
  return bundle;
}

/** Bundles one house bot from `@zerosnake/house-bots` (also used by `scripts/build.ts`). */
export async function bundleHouseBot(name: HouseBotName): Promise<string> {
  const from = resolveOwn("@zerosnake/house-bots");
  const out = await build({
    stdin: {
      contents: `export { ${name} as default } from ${JSON.stringify(from)};`,
      resolveDir: dirname(from),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    logLevel: "silent",
  });
  return out.outputFiles[0]?.text ?? "";
}
