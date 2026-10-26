// Test worker for workerd.test.ts: runs a bot in the sandbox inside workerd and returns the reports.
import type { BotInfo, BotState } from "@zerosnake/sdk";
import { createSandbox } from "../index.ts";
// Provided by the test as a CompiledWasm module, the way the arena's wrangler config will.
import wasmModule from "./quickjs.wasm";

interface Job {
  source: string;
  info: BotInfo;
  states: BotState[];
}

export default {
  async fetch(request: Request): Promise<Response> {
    const job = (await request.json()) as Job;
    const sandbox = await createSandbox({ wasmModule });
    const life = sandbox.startLife(job.source, job.info);
    const reports = job.states.map((s) => life.tick(s));
    life.dispose();
    return Response.json({ loadLog: life.loadLog, reports });
  },
};
