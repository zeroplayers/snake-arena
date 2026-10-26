import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { CheckInput } from "../index.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

/** Bundles bot source (TS, may import the SDK and the house bots) into one ESM file, like the CLI. */
export async function bundle(source: string): Promise<string> {
  const out = await build({
    stdin: { contents: source, resolveDir: here, loader: "ts", sourcefile: "bot.ts" },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    write: false,
  });
  return out.outputFiles[0]?.text ?? "";
}

/** A house bot bundled as an uploaded bot would be. */
export function houseBundle(name: "easy" | "medium" | "hard" | "chaos"): Promise<string> {
  return bundle(`export { ${name} as default } from "@zerosnake/house-bots";`);
}

/** A minimal bot module (plain JS, runs inside the sandbox) whose `tick` body is `body`. */
export function botWithTick(body: string, prefix = ""): string {
  return `${prefix}\nexport default { tick(state, mem, log) { ${body} } };`;
}

/** The input for a bundle uploaded with a single source file of the same size. */
export function input(bundleSource: string): CheckInput {
  return { bundle: bundleSource, sources: [{ path: "src/bot.ts", bytes: bundleSource.length }] };
}

/** `easy` with extra code run before its tick (`body` may return early). */
export function easyWith(body: string): Promise<string> {
  return bundle(`
    import { easy } from "@zerosnake/house-bots";
    export default { tick(state, mem, log) { ${body}; return easy.tick(state, mem, log); } };`);
}

/** Bots that must be rejected, as plain JS bundles. */
export const BAD_BOTS = {
  infiniteLoop: botWithTick("if (state.lifeTick > 20) for (;;) {} return { turn: 0 };"),
  exception: botWithTick("if (state.tick > 30) throw new Error('boom'); return { turn: 0.2 };"),
  /** Drives straight ahead into the wall, every life. */
  suicidal: botWithTick("log('straight on'); return { turn: 0 };"),
  /** Circles on the spot: never dies, never eats. */
  circler: botWithTick("return { turn: 1 };"),
  oom: botWithTick(
    "mem.junk = mem.junk || []; for (let i = 0; i < 2000; i++) mem.junk.push({ i, s: 'x' + i }); return { turn: 0.3 };",
  ),
  missingExport: "export const bot = { tick() { return { turn: 0 }; } };",
  noTick: "export default { init() { return {}; } };",
  async: botWithTick("return { turn: 0 };", "async function later() {}"),
  /** Loads fine for the load check (seed 0) but init() throws on some lives in the matches. */
  flakyInit: `export default {
    init(info) { if (info.seed % 3 === 1) throw new Error("bad seed " + info.seed); return {}; },
    tick() { return { turn: 0.3 }; },
  };`,
};
