import { createSandbox, DEFAULT_OP_BUDGET } from "@zerosnake/sandbox";
import { LOG_LIMIT_BYTES } from "@zerosnake/sdk";
import { afterAll, describe, expect, it } from "vitest";
import { bundleBot } from "./bundle.ts";
import { CliError } from "./errors.ts";
import { cleanUp, GOOD_BOT, makeProject, TUNING } from "./testing/project.ts";

afterAll(cleanUp);

describe("bundleBot", () => {
  it("bundles a bot and its SDK into one ESM file without an npm install", async () => {
    // No node_modules in the project: the SDK comes from the CLI.
    const dir = makeProject({ "src/bot.ts": GOOD_BOT, "src/tuning.ts": TUNING });
    const bot = await bundleBot("src/bot.ts", { cwd: dir });

    expect(bot.inputs.sort()).toEqual(["src/bot.ts", "src/tuning.ts"]);
    expect(bot.code).toMatch(/export\s*\{[^}]*as default/);
    expect(bot.code).not.toMatch(/^\s*import /m);
    expect(bot.bytes).toBe(Buffer.byteLength(bot.code));
  });

  it("produces a bundle the sandbox runs", async () => {
    const dir = makeProject({ "src/bot.ts": GOOD_BOT, "src/tuning.ts": TUNING });
    const bot = await bundleBot("src/bot.ts", { cwd: dir });
    const sandbox = await createSandbox();
    const life = sandbox.startLife(bot.code, {
      snakeId: "me",
      worldRadius: 100,
      visionRadius: 40,
      tickRate: 10,
      maxLifeTicks: 6000,
      opBudget: DEFAULT_OP_BUDGET,
      logLimitBytes: LOG_LIMIT_BYTES,
      seed: 1,
    });
    expect(life.death).toBeNull();
    const report = life.tick({
      tick: 0,
      lifeTick: 0,
      self: {
        id: "me",
        head: { x: 95, y: 0 },
        angle: 0,
        length: 10,
        speed: 1,
        radius: 0.5,
        turnRate: 0.2,
        boosting: false,
        segments: [{ x: 95, y: 0 }],
      },
      snakes: [],
      food: [],
      wallDistance: 5,
    });
    expect(report.outcome).toBe("ok");
    expect(report.action.turn).not.toBe(0);
    life.dispose();
  });

  it("reports syntax errors with file:line:column", async () => {
    const dir = makeProject({ "src/bot.ts": "export default {\n  tick( {\n};\n" });
    const error = await bundleBot("src/bot.ts", { cwd: dir }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as Error).message).toContain("Couldn't bundle src/bot.ts");
    expect((error as Error).message).toMatch(/src\/bot\.ts:3:\d+/);
  });

  it("reports a missing import with the importing line", async () => {
    const dir = makeProject({
      "src/bot.ts": 'import { x } from "./nope.ts";\nexport default x;\n',
    });
    const error = (await bundleBot("src/bot.ts", { cwd: dir }).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/src\/bot\.ts:1:\d+/);
    expect(error.message).toContain("./nope.ts");
  });

  it("explains a missing default export", async () => {
    const dir = makeProject({
      "src/bot.ts":
        'import { defineBot } from "@zerosnake/sdk";\nexport const bot = defineBot({ tick: () => ({ turn: 0 }) });\n',
    });
    const error = (await bundleBot("src/bot.ts", { cwd: dir }).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(CliError);
    expect(error.message).toContain("src/bot.ts has no default export");
    expect(error.message).toContain("export default defineBot(");
  });

  it("points at the source line that uses syntax the sandbox refuses", async () => {
    const dir = makeProject({
      "src/bot.ts":
        'import { plan } from "./plan.ts";\nexport default { tick: () => ({ turn: plan() }) };\n',
      "src/plan.ts":
        "const big = 1;\nexport function plan() {\n  return big;\n}\nexport const later = async () => 1;\nlater();\n",
    });
    const error = (await bundleBot("src/bot.ts", { cwd: dir }).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(CliError);
    expect(error.message).toMatch(/^src\/plan\.ts:5: async functions are not available to bots/);
    expect(error.message).toContain('(found "async")');
  });

  it("checks the bundle like the server does: comments and dead code don't count", async () => {
    const dir = makeProject({
      "src/bot.ts":
        "// async code never runs in the sandbox, and 10n is a BigInt.\n" +
        "/* async */ async function unused() {}\n" +
        "export default { tick: () => ({ turn: 0 }) };\n",
    });
    const bot = await bundleBot("src/bot.ts", { cwd: dir });
    expect(bot.code).not.toContain("async");
  });
});
