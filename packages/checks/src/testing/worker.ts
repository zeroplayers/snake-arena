// Test worker for workerd.test.ts: runs the checks inside workerd, as the Queue consumer will.
import { type CheckInput, type CheckOptions, runChecks } from "../index.ts";
// Provided by the test as a CompiledWasm module, the way the consumer's wrangler config will.
import wasmModule from "./quickjs.wasm";

export default {
  async fetch(request: Request): Promise<Response> {
    const job = (await request.json()) as { inputs: CheckInput[]; options: CheckOptions };
    const reports = [];
    for (const input of job.inputs)
      reports.push(await runChecks(input, { ...job.options, wasmModule }));
    return Response.json(reports);
  },
};
