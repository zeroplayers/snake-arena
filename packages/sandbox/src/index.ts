/**
 * `@zerosnake/sandbox`: runs bot code in QuickJS (wasm), the same way in Node (CLI, tests) and in
 * a Durable Object (arena).
 *
 * ```ts
 * const sandbox = await createSandbox({ wasmModule }); // wasmModule only in Workers
 * const life = sandbox.startLife(bundle, info);
 * const report = life.tick(state); // report.action, report.death, report.log, ...
 * life.dispose();
 * ```
 *
 * @packageDocumentation
 */

export { type InstrumentResult, instrument, MAX_STRING_LENGTH } from "./instrument.ts";
export {
  type BotLife,
  createSandbox,
  DEFAULT_OP_BUDGET,
  DEFAULT_WASM_MEMORY_CAP_BYTES,
  type Death,
  type Fault,
  type LifeOptions,
  Sandbox,
  type SandboxOptions,
  type TickLogOutput,
  type TickOutcome,
  type TickReport,
  type WasmModule,
  WORK_PER_OP,
} from "./sandbox.ts";
export { checkSource } from "./source.ts";
