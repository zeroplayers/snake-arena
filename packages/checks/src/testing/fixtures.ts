import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { CheckInput } from "../index.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * Bundles bot source (TS, may import the SDK and the house bots) into one ESM file, like the CLI.
 * `minify` builds it the way some authors ship theirs.
 */
export async function bundle(source: string, minify = false): Promise<string> {
  const out = await build({
    stdin: { contents: source, resolveDir: here, loader: "ts", sourcefile: "bot.ts" },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    minify,
    write: false,
  });
  return out.outputFiles[0]?.text ?? "";
}

/** A house bot bundled as an uploaded bot would be. */
export function houseBundle(
  name: "easy" | "medium" | "hard" | "chaos",
  minify = false,
): Promise<string> {
  return bundle(`export { ${name} as default } from "@zerosnake/house-bots";`, minify);
}

/** The starter bot of `zerosnake init` (the repo's `template/`), bundled like the CLI does. */
export function templateBundle(minify = false): Promise<string> {
  return bundle(`export { default } from "../../../../template/src/bot.ts";`, minify);
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

/**
 * `easy` plus a loop of `iterations` whose body is `statements` long: within the op budget (the
 * sandbox counts interrupt polls, one per ~4,300 iterations) but slow per op (#60).
 */
export function longBody(statements: number, iterations: number): Promise<string> {
  const body = Array.from({ length: statements }, (_, k) => `x = (x * ${k + 3} + i) % 1000003;`);
  return easyWith(
    `let x = 1; for (let i = 0; i < ${iterations}; i++) { ${body.join(" ")} } mem.x = x`,
  );
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
  /**
   * init() throws on some lives: with the test seeds (101, 202, 303) the load check's life loads,
   * so it passes, and a later one throws. It drives straight into the wall, so it has many lives
   * (and life seeds) even in a short check.
   */
  flakyInit: `export default {
    init(info) { if (info.seed % 3 === 1) throw new Error("bad seed " + info.seed); return {}; },
    tick() { return { turn: 0 }; },
  };`,
};
