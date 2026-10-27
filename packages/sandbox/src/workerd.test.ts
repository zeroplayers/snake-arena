import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSandbox } from "./index.ts";
import { botWithTick, bundleExampleBot, makeInfo, makeStates } from "./testing/fixtures.ts";

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
          name: "sandbox",
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
  it("produces identical reports to Node for the same bot", async () => {
    const source = await bundleExampleBot();
    const info = makeInfo({ seed: 3 });
    const states = makeStates(60);

    const response = await mf.dispatchFetch("http://sandbox/", {
      method: "POST",
      body: JSON.stringify({ source, info, states }),
    });
    expect(response.status).toBe(200);
    const fromWorkerd = await response.json();

    const sandbox = await createSandbox();
    const life = sandbox.startLife(source, info);
    const fromNode = JSON.parse(
      JSON.stringify({ loadLog: life.loadLog, reports: states.map((s) => life.tick(s)) }),
    );
    expect(fromWorkerd).toEqual(fromNode);
    expect(fromNode.reports.some((r: { log: { lines: string[] } }) => r.log.lines.length > 0)).toBe(
      true,
    );
  });

  it("contains hostile bots the same way", async () => {
    const source = botWithTick(`
      if (state.lifeTick === 0) { const a = []; a.length = 1e8; a.indexOf(1); }
      if (state.lifeTick === 1) { log(Math.random()); return { turn: 0.5 }; }
      for (;;) {}`);
    const info = makeInfo();
    const states = makeStates(5);
    const response = await mf.dispatchFetch("http://sandbox/", {
      method: "POST",
      body: JSON.stringify({ source, info, states }),
    });
    const fromWorkerd = (await response.json()) as { reports: unknown[] };
    const sandbox = await createSandbox();
    const life = sandbox.startLife(source, info);
    const fromNode = JSON.parse(JSON.stringify(states.map((s) => life.tick(s))));
    expect(fromWorkerd.reports).toEqual(fromNode);
    expect(fromNode.map((r: { outcome: string }) => r.outcome)).toEqual([
      "error",
      "ok",
      "timeout",
      "timeout",
      "timeout",
    ]);
  });

  it("charges the same cost units as Node (#60)", async () => {
    const body = Array.from({ length: 120 }, (_, i) => `x = (x * 31 + ${i}) | 0;`).join(" ");
    const source = botWithTick(
      `
      const t = state.lifeTick % 4;
      let x = 0;
      if (t === 0) { for (let i = 0; i < 50; i++) { ${body} } }
      if (t === 1) { for (let i = 0; i < 20; i++) { try { null.x; } catch (e) { x++; } } }
      if (t === 2) { const o = { ...state.self, ...[1, 2] }; for (const k in o) x++; x += [...state.food].length; }
      if (t === 3) { for (;;) { ${body} } }
      return { turn: x > 0 ? 0.25 : 0 };`,
    );
    const info = makeInfo();
    const states = makeStates(8);
    const response = await mf.dispatchFetch("http://sandbox/", {
      method: "POST",
      body: JSON.stringify({ source, info, states }),
    });
    const fromWorkerd = (await response.json()) as { reports: unknown[] };
    const sandbox = await createSandbox();
    const life = sandbox.startLife(source, info, {});
    const fromNode = JSON.parse(JSON.stringify(states.map((s) => life.tick(s))));
    expect(fromWorkerd.reports).toEqual(fromNode);
    expect(fromNode.map((r: { outcome: string }) => r.outcome)).toEqual([
      "ok",
      "ok",
      "ok",
      "timeout",
      "ok",
      "ok",
      "ok",
      "timeout",
    ]);
    expect(fromNode.every((r: { work: number }) => r.work > 0)).toBe(true);
  });
});
