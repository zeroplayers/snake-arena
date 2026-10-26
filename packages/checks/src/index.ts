/**
 * `@zerosnake/checks`: the deploy checks of SPEC §6, shared by `zerosnake test` (Node) and the
 * version-check Queue consumer (workerd). The same bundle gets the same report in both.
 *
 * ```ts
 * const report = await runChecks({ bundle, sources }, { wasmModule }); // wasmModule only in Workers
 * report.passed;           // deploy or reject
 * JSON.stringify(report);  // store with the version
 * formatReport(report);    // print for the author
 * ```
 *
 * @packageDocumentation
 */

export { formatReport } from "./format.ts";
export {
  formatBytes,
  LIMITS,
  type LimitProblem,
  type LimitsDetails,
  type SourceFile,
} from "./limits.ts";
export {
  CANDIDATE_ID,
  type FaultDetails,
  type LifeEnd,
  type LifeResult,
  OPPONENTS,
  type TickStats,
} from "./match.ts";
export type {
  CheckId,
  CheckReport,
  CheckStatus,
  LimitsCheck,
  LoadCheck,
  QualifyCheck,
  RunCheck,
  SeedRun,
  SeedScore,
} from "./report.ts";
export { REPORT_VERSION } from "./report.ts";
export {
  CHECK_SEEDS,
  CHECK_TICKS,
  type CheckInput,
  type CheckOptions,
  runChecks,
} from "./suite.ts";
