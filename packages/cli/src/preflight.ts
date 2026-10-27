import { buildBotInfo, createWorld, spawnSnake } from "@zerosnake/engine";
import { DEFAULT_OP_BUDGET, type Sandbox } from "@zerosnake/sandbox";
import { LOG_LIMIT_BYTES } from "@zerosnake/sdk";
import { CliError } from "./errors.ts";
import { describeVerdict, verdictHint } from "./sim/match.ts";

/**
 * Loads a bundle in the sandbox once (module evaluation plus `init()`, under the load budget)
 * and throws a {@link CliError} in plain language if it dies doing so. Lets `sim` and `test`
 * fail fast instead of showing a snake that dies on its first tick.
 */
export function assertLoads(sandbox: Sandbox, name: string, bundle: string, seed = 1): void {
  const world = createWorld({ seed });
  const snake = spawnSnake(world, { id: `${name}#1`, author: name });
  const info = buildBotInfo(world, snake, {
    opBudget: DEFAULT_OP_BUDGET,
    logLimitBytes: LOG_LIMIT_BYTES,
  });
  const life = sandbox.startLife(bundle, info);
  const death = life.death;
  const log = life.loadLog.lines;
  life.dispose();
  if (!death) return;
  const lines = [`${name} ${describeVerdict(death)}`];
  if (log.length > 0) lines.push("", "Its log while loading:", ...log.map((l) => `  ${l}`));
  lines.push("", verdictHint(death.reason));
  throw new CliError(lines.join("\n"));
}
