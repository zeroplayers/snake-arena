import { fileURLToPath } from "node:url";
import { type BotInfo, type BotState, LOG_LIMIT_BYTES } from "@zerosnake/sdk";
import { build } from "esbuild";
import { DEFAULT_OP_BUDGET } from "../sandbox.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * Bundles bot source (TS, may import `@zerosnake/sdk`) into one ESM file, like the CLI will.
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

/** Bundles the example bot in this folder. */
export function bundleExampleBot(minify = false): Promise<string> {
  return bundle(`export { default } from "./example-bot.ts";`, minify);
}

export function makeInfo(overrides: Partial<BotInfo> = {}): BotInfo {
  return {
    snakeId: "me",
    worldHalfSize: 1000,
    visionRadius: 300,
    tickRate: 10,
    maxLifeTicks: 864_000,
    opBudget: DEFAULT_OP_BUDGET,
    logLimitBytes: LOG_LIMIT_BYTES,
    seed: 42,
    ...overrides,
  };
}

/** Deterministic, varied states: food around, a snake that sometimes comes close, the wall. */
export function makeStates(count: number): BotState[] {
  const states: BotState[] = [];
  for (let t = 0; t < count; t++) {
    const a = t * 0.37;
    const head = { x: Math.cos(a) * 400, y: Math.sin(a) * 400 };
    const near = t % 7 === 3;
    const enemyAt = near ? { x: head.x + 6, y: head.y - 1 } : { x: head.x + 80, y: head.y + 40 };
    states.push({
      tick: 100 + t,
      lifeTick: t,
      self: {
        id: "me",
        head,
        angle: (a % (2 * Math.PI)) - Math.PI,
        length: 10 + t,
        speed: 2,
        radius: 2,
        turnRate: 0.1,
        boosting: false,
        spawnGrace: 0,
        segments: [head, { x: head.x - 2, y: head.y }],
      },
      snakes: [
        {
          id: "enemy",
          author: "bob",
          length: 30,
          radius: 2,
          head: enemyAt,
          angle: Math.PI,
          boosting: false,
          spawnGrace: 0,
          segments: [enemyAt, { x: enemyAt.x + 2, y: enemyAt.y }],
        },
      ],
      food: Array.from({ length: 10 }, (_, i) => ({
        x: head.x + Math.cos(i + t) * (20 + i * 9),
        y: head.y + Math.sin(i * 2 + t) * (15 + i * 7),
        value: 1,
      })),
      wallDistance: t % 11 === 10 ? 5 : 600,
    });
  }
  return states;
}

export function oneState(): BotState {
  return makeStates(1)[0] as BotState;
}

/** A minimal bot module whose `tick` body is `body` (plain JS, runs inside the sandbox). */
export function botWithTick(body: string, prefix = ""): string {
  return `${prefix}\nexport default { tick(state, mem, log) { ${body} } };`;
}
