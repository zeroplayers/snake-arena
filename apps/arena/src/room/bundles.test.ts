import { createSandbox, DEFAULT_OP_BUDGET, instrument } from "@zerosnake/sandbox";
import { type BotInfo, LOG_LIMIT_BYTES } from "@zerosnake/sdk";
import { describe, expect, it } from "vitest";
import { BundleCache, lifeStarter } from "./bundles.ts";

const info: BotInfo = {
  snakeId: "me",
  worldHalfSize: 1000,
  visionRadius: 300,
  tickRate: 10,
  maxLifeTicks: 864_000,
  opBudget: DEFAULT_OP_BUDGET,
  logLimitBytes: LOG_LIMIT_BYTES,
  seed: 42,
};

const bot = (name: string) =>
  `export default { init() { console.log(${JSON.stringify(name)}); }, tick() { return {}; } };`;

describe("BundleCache", () => {
  it("instruments each source once, across sandboxes, and forgets bundles no life uses", async () => {
    const instrumented: string[] = [];
    const bundles = new BundleCache((source) => {
      instrumented.push(source);
      return instrument(source);
    });
    await bundles.prepare([bot("a"), bot("b"), bot("a")]);
    expect(instrumented).toEqual([bot("a"), bot("b")]);
    // A rerun gets a fresh sandbox; the room's bundles stay.
    for (let i = 0; i < 2; i++) {
      const starter = lifeStarter(await createSandbox(), bundles);
      await starter.prepare([bot("a"), bot("b")]);
      expect(starter.startLife(bot("a"), info).loadLog.lines).toEqual(["a"]);
    }
    expect(instrumented).toHaveLength(2);
    await bundles.prepare([bot("b")]);
    await bundles.prepare([bot("a"), bot("b")]);
    expect(instrumented).toEqual([bot("a"), bot("b"), bot("a")]);
  });

  it("starts lives from the bundle the room instrumented, not by instrumenting again", async () => {
    // A bundle that isn't `source`'s own shows which one the sandbox ran.
    const bundles = new BundleCache(() => instrument(bot("prepared")));
    const starter = lifeStarter(await createSandbox(), bundles);
    await starter.prepare([bot("source")]);
    expect(starter.startLife(bot("source"), info).loadLog.lines).toEqual(["prepared"]);
    // Not prepared: the sandbox instruments it itself.
    expect(starter.startLife(bot("other"), info).loadLog.lines).toEqual(["other"]);
  });
});
