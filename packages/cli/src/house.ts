import { dirname } from "node:path";
import { build } from "esbuild";
import { resolveOwn } from "./paths.ts";

/** House bots `--vs` accepts by name, weakest first (`chaos` is random, not ranked). */
export const HOUSE_BOTS = ["easy", "medium", "hard", "chaos"] as const;
export type HouseBotName = (typeof HOUSE_BOTS)[number];

export function isHouseBot(name: string): name is HouseBotName {
  return (HOUSE_BOTS as readonly string[]).includes(name);
}

const cache = new Map<HouseBotName, Promise<string>>();

/**
 * A house bot as a sandbox bundle. House bots are named exports of `@zerosnake/house-bots`, so
 * this bundles a one-line entry that re-exports one as the default, exactly like a user bot.
 */
export function houseBotBundle(name: HouseBotName): Promise<string> {
  let bundle = cache.get(name);
  if (!bundle) {
    const entry = resolveOwn("@zerosnake/house-bots");
    bundle = build({
      stdin: {
        contents: `export { ${name} as default } from ${JSON.stringify(entry)};`,
        resolveDir: dirname(entry),
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      target: "es2023",
      logLevel: "silent",
    }).then((r) => r.outputFiles[0]?.text ?? "");
    cache.set(name, bundle);
  }
  return bundle;
}
