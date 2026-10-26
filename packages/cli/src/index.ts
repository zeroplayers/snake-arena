/**
 * `zerosnake`: the CLI (`npx zerosnake init | sim | test`). The binary is `bin/zerosnake.js`;
 * these exports are for tests and for the later `deploy` command, which bundles the same way.
 *
 * @packageDocumentation
 */
export { type BundledBot, type BundleOptions, bundleBot } from "./bundle.ts";
export { HELP, main } from "./cli.ts";
export { CliError, EXIT, UsageError } from "./errors.ts";
export { HOUSE_BOTS, type HouseBotName, houseBotBundle } from "./house.ts";
export { type InitOptions, type InitResult, initProject, packageName } from "./init.ts";
export type { Io } from "./io.ts";
export { assertLoads } from "./preflight.ts";
export {
  collectSources,
  findEntry,
  findProject,
  type Project,
  type SourceFile,
} from "./project.ts";
export {
  type BotSummary,
  type Contestant,
  describeVerdict,
  type MatchOptions,
  type MatchResult,
  runMatch,
  verdictHint,
} from "./sim/match.ts";
export type { MatchUpdate, SimChunk, SimLife, SnakeCall, TickCalls } from "./sim/protocol.ts";
export { RecordedMatchSource } from "./sim/source.ts";
export { describeDeath, formatSummary } from "./sim/summary.ts";
export { copyTemplate, findTemplateDir } from "./template.ts";
