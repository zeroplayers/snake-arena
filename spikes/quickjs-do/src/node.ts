import variant from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import { runBench, runSafety } from "./bench.ts";
import type { BotKind } from "./bots.ts";

const now = () => performance.now();

const t0 = now();
const qjs = await newQuickJSWASMModuleFromVariant(variant);
console.log(`module load: ${(now() - t0).toFixed(1)} ms`);

const rows = [];
for (const kind of ["typical", "heavy"] as BotKind[]) {
  for (const bots of [1, 10, 20, 40]) {
    const r = runBench(qjs, { bots, ticks: 200, kind }, now);
    rows.push({
      kind,
      bots,
      "setup ms/bot": +(r.setupMs / bots).toFixed(2),
      "us/bot-tick": +r.usPerBotTick.toFixed(1),
      "ms/tick (all bots)": +((r.usPerBotTick * bots) / 1000).toFixed(2),
      "interrupts avg/max": `${r.interruptsPerBotTick.avg.toFixed(1)}/${r.interruptsPerBotTick.max}`,
      "KB/ctx": Math.round(r.memoryBytesPerContext / 1024),
      errors: r.errors,
      "state KB": +(r.stateBytes / 1024).toFixed(1),
    });
  }
}
console.table(rows);
console.table(runSafety(qjs, now));
