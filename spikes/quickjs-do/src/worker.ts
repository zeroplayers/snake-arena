import { DurableObject } from "cloudflare:workers";
import baseVariant from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
// Wrangler only treats specifiers ending in .wasm as compiled modules, and the package export ("./wasm") does not.
import wasmModule from "../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm";
import { runBench, runSafety } from "./bench.ts";
import type { BotKind } from "./bots.ts";

/**
 * QuickJS's per-runtime memory limit misses large allocations (big arrays, strings), so one bot
 * could grow the shared wasm heap until the isolate dies. Capping the wasm memory itself turns that
 * into a clean "out of memory" for the offending bot. 64 MB ≈ 1024 wasm pages.
 */
const WASM_MEMORY_CAP_PAGES = 1024;

function createVariant() {
  // Workers cannot compile wasm from bytes at runtime, so hand emscripten the precompiled module.
  const wasmMemory = new WebAssembly.Memory({ initial: 256, maximum: WASM_MEMORY_CAP_PAGES });
  return newVariant(baseVariant, { wasmModule, wasmMemory });
}

interface Env {
  BENCH: DurableObjectNamespace<BenchRoom>;
}

/**
 * GET /bench?bots=20&ticks=100&kind=typical[&budget=1000][&room=name]
 * GET /safety[?room=name]
 * GET /noop[?room=name]      — baseline round trip, for subtracting from client timings
 *
 * Each `room` is a separate DO instance; pass a fresh name to measure a cold start.
 */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const room = url.searchParams.get("room") ?? "bench";
    const stub = env.BENCH.get(env.BENCH.idFromName(room));
    return stub.fetch(req);
  },
} satisfies ExportedHandler<Env>;

export class BenchRoom extends DurableObject<Env> {
  private qjs?: Promise<QuickJSWASMModule>;

  private module(): Promise<QuickJSWASMModule> {
    this.qjs ??= newQuickJSWASMModuleFromVariant(createVariant());
    return this.qjs;
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const q = url.searchParams;
    // Workers freeze the clock during CPU work; these numbers are only meaningful in workerd dev.
    const now = () => performance.now();

    if (url.pathname === "/noop") return Response.json({ ok: true });

    const coldStart = this.qjs === undefined;
    const qjs = await this.module();

    if (url.pathname === "/bench") {
      const opts = {
        bots: Number(q.get("bots") ?? 20),
        ticks: Number(q.get("ticks") ?? 100),
        kind: (q.get("kind") ?? "typical") as BotKind,
        ...(q.has("budget") ? { budget: Number(q.get("budget")) } : {}),
      };
      return Response.json({ coldStart, ...runBench(qjs, opts, now) });
    }
    if (url.pathname === "/safety") {
      return Response.json({
        coldStart,
        results: runSafety(qjs, now, undefined, q.get("case") ?? undefined),
      });
    }
    return new Response("not found", { status: 404 });
  }
}
