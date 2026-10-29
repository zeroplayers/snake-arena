import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CheckInput, runChecks } from "./index.ts";
import { BAD_BOTS, houseBundle, input } from "./testing/fixtures.ts";

let mf: Miniflare;

beforeAll(async () => {
  const worker = await build({
    entryPoints: [fileURLToPath(new URL("./testing/worker.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["./quickjs.wasm"],
    write: false,
  });
  const wasmPath = createRequire(import.meta.url).resolve(
    "@jitl/quickjs-wasmfile-release-sync/wasm",
  );
  mf = new Miniflare({
    workers: [
      {
        config: {
          name: "checks",
          compatibilityDate: "2026-10-01",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": { type: "esm", contents: worker.outputFiles[0]?.text ?? "" },
              "quickjs.wasm": { type: "wasm", contents: new Uint8Array(await readFile(wasmPath)) },
            },
          },
        },
      },
    ],
  });
  await mf.ready;
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

describe("workerd", () => {
  it("gives the same reports as Node, for honest and bad bots", async () => {
    const inputs = [
      input(await houseBundle("medium")),
      input(BAD_BOTS.suicidal),
      input(BAD_BOTS.infiniteLoop),
      input(BAD_BOTS.exception),
      input(BAD_BOTS.oom),
      input(BAD_BOTS.missingExport),
    ];
    // Shorter matches than a deploy gets, to keep the test quick; the next test runs the full
    // configuration once.
    const options = { seeds: [101, 303], ticks: 500 };
    const response = await mf.dispatchFetch("http://checks/", {
      method: "POST",
      body: JSON.stringify({ inputs, options }),
    });
    expect(response.status).toBe(200);
    const fromWorkerd = await response.json();

    const fromNode = [];
    for (const i of inputs) fromNode.push(await runChecks(i, options));
    expect(fromWorkerd).toEqual(JSON.parse(JSON.stringify(fromNode)));
    // Too short to judge qualification (the full run below does), so the suicidal bot, which
    // only fails that, can pass here by luck; the other bad bots fail anyway.
    expect(fromNode.slice(2).map((r) => r.passed)).toEqual([false, false, false, false]);
  }, 180_000);

  it("gives the same report as Node with the full deploy configuration", async () => {
    const inputs = [input(await houseBundle("medium"))];
    const response = await mf.dispatchFetch("http://checks/", {
      method: "POST",
      body: JSON.stringify({ inputs, options: {} }),
    });
    const [fromWorkerd] = (await response.json()) as unknown[];
    const fromNode = await runChecks(inputs[0] as CheckInput);
    expect(fromNode.ticks).toBe(1000);
    expect(fromNode.seeds).toHaveLength(5);
    expect(fromNode.passed).toBe(true);
    expect(fromWorkerd).toEqual(JSON.parse(JSON.stringify(fromNode)));
  }, 180_000);
});
