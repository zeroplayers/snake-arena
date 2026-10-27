import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHECK_SEED_COUNT,
  CHECK_TICKS,
  type CheckReport,
  DEFAULT_MAX_MILLIS,
  formatReport as formatCheckReport,
  REPORT_VERSION,
  runChecks,
} from "@zerosnake/checks";
import {
  checkReportLines,
  DEPLOY_LIMITS,
  type DeployLimits,
  type DeployMeta,
  type DeployRequest,
} from "@zerosnake/web/shared";
import type { BundledBot } from "./bundle.ts";
import { CliError } from "./errors.ts";
import type { Io } from "./io.ts";
import { collectSources } from "./project.ts";
import { dim, green, red, yellow } from "./term.ts";

/** A source file as `deploy` uploads it. */
export interface SourceText {
  /** Relative to the project root, `/`-separated. */
  path: string;
  content: string;
  /** UTF-8 size of `content`. */
  bytes: number;
}

/**
 * The sources that go with a deploy (they're public on the bot's page): everything under `src/`,
 * plus any other file of the project the bundle pulled in, except a vendored SDK.
 */
export function readSources(root: string, bundle: BundledBot): SourceText[] {
  const paths = new Set(collectSources(root).map((f) => f.path));
  for (const input of bundle.inputs) {
    if (!input.startsWith("../") && !input.startsWith("vendor/")) paths.add(input);
  }
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  return [...paths].sort().map((path) => {
    const bytes = readFileSync(join(root, path));
    try {
      return { path, content: utf8.decode(bytes), bytes: bytes.byteLength };
    } catch {
      throw new CliError(
        `${path} isn't a text file, and deploys only carry text sources. Move it out of src/.`,
      );
    }
  });
}

/** The body of `POST /api/bots/:bot/versions`. */
export function deployRequest(
  bundle: BundledBot,
  sources: SourceText[],
  meta?: DeployMeta,
): DeployRequest {
  return {
    bundle: bundle.code,
    sources: sources.map(({ path, content }) => ({ path, content })),
    ...(meta ? { meta } : {}),
  };
}

/** Bytes on the wire for `request`, as `Api.call` sends it: what the server's `maxBodyBytes` caps. */
export function uploadBytes(request: DeployRequest): number {
  return Buffer.byteLength(JSON.stringify(request));
}

export interface Check {
  name: string;
  ok: boolean;
  message?: string;
}

const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/;

/**
 * Why the deploy API would refuse `path`, or `null`. Mirrors `sourcePathProblem` in
 * apps/web/src/server/cli-api.ts (not exported through `@zerosnake/web/shared`).
 */
export function sourcePathProblem(path: string, maxLength: number): string | null {
  if (path.length > maxLength) return `is longer than ${maxLength} characters`;
  for (const segment of path.split("/")) {
    if (segment === "." || segment === ".." || segment === "") return "isn't a plain relative path";
    if (!PATH_SEGMENT.test(segment)) {
      return "may only contain letters, digits and . _ - @ + (no spaces)";
    }
  }
  return null;
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${+(n / (1024 * 1024)).toFixed(2)} MB`;
  if (n >= 1024) return `${+(n / 1024).toFixed(1)} KB`;
  return `${n} bytes`;
}

/**
 * The deploy API's request limits (SPEC §6), checked before uploading anything. `limits` are the
 * server's (`GET /api/me`) when signed in, else the defaults. `meta` is what `deploy` sends with
 * the upload, so the upload size is exact.
 */
export function limitChecks(
  bundle: BundledBot,
  sources: SourceText[],
  limits: DeployLimits = DEPLOY_LIMITS,
  meta?: DeployMeta,
): Check[] {
  const sourceBytes = sources.reduce((sum, f) => sum + f.bytes, 0);
  const badPath = sources
    .map((f) => ({ path: f.path, problem: sourcePathProblem(f.path, limits.maxPathLength) }))
    .find((p) => p.problem);
  const seen = new Map<string, string>();
  let twice: [string, string] | undefined;
  for (const { path } of sources) {
    const other = seen.get(path.toLowerCase());
    if (other) twice ??= [other, path];
    seen.set(path.toLowerCase(), path);
  }
  const body = uploadBytes(deployRequest(bundle, sources, meta));
  return [
    {
      name: "bundle size",
      ok: bundle.bytes <= limits.maxBundleBytes,
      message: `${formatBytes(bundle.bytes)} of ${formatBytes(limits.maxBundleBytes)}`,
    },
    {
      name: "source files",
      ok: sources.length > 0 && sources.length <= limits.maxSourceFiles,
      message:
        sources.length === 0
          ? "no files under src/"
          : `${sources.length} of ${limits.maxSourceFiles}`,
    },
    {
      name: "source size",
      ok: sourceBytes <= limits.maxSourceBytes,
      message: `${formatBytes(sourceBytes)} of ${formatBytes(limits.maxSourceBytes)}`,
    },
    {
      name: "source paths",
      ok: !badPath && !twice,
      ...(badPath
        ? { message: `${badPath.path} ${badPath.problem}` }
        : twice
          ? { message: `${twice[0]} and ${twice[1]} differ only in letter case` }
          : {}),
    },
    {
      name: "upload size",
      ok: body <= limits.maxBodyBytes,
      message: `${formatBytes(body)} of ${formatBytes(limits.maxBodyBytes)}`,
    },
  ];
}

/**
 * The deploy API's limits, checked on this machine before anything is uploaded. Prints one line;
 * throws a {@link CliError} if the upload would be refused.
 */
export function assertWithinLimits(
  io: Io,
  bundle: BundledBot,
  sources: SourceText[],
  limits?: DeployLimits,
  meta?: DeployMeta,
): void {
  const limitResults = limitChecks(bundle, sources, limits, meta);
  const failed = limitResults.filter((c) => !c.ok);
  if (failed.length > 0) {
    throw new CliError(
      `Over the deploy limits:\n${failed.map((c) => `  ${red("✗")} ${c.name}: ${c.message}`).join("\n")}\n` +
        "Everything under src/ is uploaded with the bundle: move data files and notes out of it.",
    );
  }
  const sizes = limitResults
    .filter((c) => c.name !== "source paths")
    .map((c) => `${c.name} ${c.message}`)
    .join(", ");
  io.out(`${green("✓")} within the deploy limits ${dim(`(${sizes})`)}`);
}

/** What {@link runLocalChecks} found: the suite's report and how long the suite took here. */
export interface LocalChecks {
  report: CheckReport;
  millis: number;
}

/**
 * The checks `test` and `deploy` run on this machine before anything is uploaded: the deploy
 * API's limits ({@link assertWithinLimits}, throws), then the server's check suite
 * ({@link runCheckSuite}). Returns the suite's report; the caller prints it.
 */
export async function runLocalChecks(
  io: Io,
  bundle: BundledBot,
  sources: SourceText[],
  limits?: DeployLimits,
  meta?: DeployMeta,
): Promise<LocalChecks> {
  assertWithinLimits(io, bundle, sources, limits, meta);
  const started = performance.now();
  const report = await runCheckSuite(io, bundle, sources);
  return { report, millis: performance.now() - started };
}

/**
 * Above this, a suite that passed here may not finish on the server. There the suite's wall
 * clock (the 60 s cap) doesn't decide: the Worker's CPU time limit does, on hardware that can be
 * slower than the author's. Honest bots take 2–5 s.
 */
export const SLOW_SUITE_MS = 20_000;

/** A warning for a suite that took {@link SLOW_SUITE_MS} or more here, else `null`. */
export function slowSuiteWarning(millis: number): string | null {
  if (millis < SLOW_SUITE_MS) return null;
  return (
    `${yellow("!")} The checks took ${Math.round(millis / 1000)} s here (most bots take a few). ` +
    "The server runs them under a CPU time limit instead of the " +
    `${DEFAULT_MAX_MILLIS / 1000} s clock, possibly on a slower machine; if they don't finish ` +
    "there, the version is rejected. Make the bot's ticks cheaper to be safe."
  );
}

/** What the suite plays, for the progress line. */
const SUITE = `${CHECK_SEED_COUNT} matches × ${CHECK_TICKS} ticks against the house bots`;

/**
 * `runChecks` of `@zerosnake/checks` with the deploy configuration, exactly as the server runs
 * it (same seeds, same report), with a progress line on the terminal while it runs.
 */
export async function runCheckSuite(
  io: Io,
  bundle: BundledBot,
  sources: readonly SourceText[],
): Promise<CheckReport> {
  if (!io.progress) io.err(dim(`Running the checks (${SUITE})…`));
  const started = performance.now();
  let reads = 0;
  let shown = Number.NEGATIVE_INFINITY;
  // The suite runs synchronously and has no progress callback. Its wall clock (the 60 s cap) is
  // read once per tick of the bot and once per life, so counting the reads tells how far it is.
  // It still returns the real time: the cap and the report are the same as without it.
  const clock = () => {
    const now = performance.now();
    reads++;
    if (io.progress && now - shown >= 100) {
      shown = now;
      const percent = Math.min(99, Math.floor((reads / (CHECK_SEED_COUNT * CHECK_TICKS)) * 100));
      io.progress(
        `Running the checks (${SUITE})… ${percent}% ${dim(`${Math.round((now - started) / 1000)}s`)}`,
      );
    }
    return now;
  };
  try {
    return await runChecks(
      { bundle: bundle.code, sources: sources.map(({ path, bytes }) => ({ path, bytes })) },
      { clock },
    );
  } finally {
    io.progress?.("");
  }
}

/** One line for a report that passed: the score against the bar. */
export function passedLine(report: CheckReport): string {
  const { score, bar } = report.qualify;
  const scores =
    score !== null && bar !== null
      ? ` ${dim(`(mean score per life ${score.toFixed(1)}, easy in your seat ${bar.toFixed(1)})`)}`
      : "";
  return `${green("✓")} passes the checks${scores}`;
}

/** Whether a stored report is `@zerosnake/checks`' {@link CheckReport}. */
function isSuiteReport(report: unknown): report is CheckReport {
  const r = report as Partial<CheckReport> | null;
  return (
    typeof r === "object" &&
    r !== null &&
    r.version === REPORT_VERSION &&
    typeof r.passed === "boolean" &&
    [r.limits, r.load, r.run, r.qualify].every((c) => typeof c?.summary === "string")
  );
}

/**
 * The names the suite's own checks have in a stored report (apps/arena's `versionReport`). Any
 * other check was added after the suite ran: a moderator's ban, the arena's backstop.
 */
const SUITE_CHECK_NAMES = new Set(["limits", "loads", "seeds", "qualification"]);

/**
 * Lines for a stored version report (`versions.report`), tolerant of fields it doesn't know:
 * - the checks consumer's `{ ok, checks, suite, text, qualificationScore }`: its `suite` (a
 *   `@zerosnake/checks` report) as `zerosnake test` prints it, else its `text`; failed checks
 *   that aren't the suite's go first, since they're why a version the suite passed was rejected;
 * - a bare `@zerosnake/checks` report, printed the same way;
 * - else the `{ ok, checks, qualificationScore }` lines.
 */
export function formatReport(report: unknown): string[] {
  const r = report as {
    checks?: unknown;
    qualificationScore?: unknown;
    suite?: unknown;
    text?: unknown;
  } | null;
  const suite = isSuiteReport(report) ? report : isSuiteReport(r?.suite) ? r.suite : null;
  const text = suite ? formatCheckReport(suite) : typeof r?.text === "string" ? r.text : "";
  if (text.trim()) {
    const lines = text
      .trimEnd()
      .split("\n")
      .map((line) => (line ? `  ${line}` : line));
    const added = Array.isArray(r?.checks)
      ? (r.checks as { name?: unknown; ok?: unknown; message?: unknown }[]).filter(
          (c) =>
            c.ok === false &&
            typeof c.name === "string" &&
            !SUITE_CHECK_NAMES.has(c.name) &&
            // The server may have put it in `text` already.
            !(typeof c.message === "string" && c.message && text.includes(c.message)),
        )
      : [];
    if (added.length === 0) return lines;
    const verdicts = checkReportLines({
      ok: false,
      checks: added.map((c) => ({
        name: String(c.name),
        ok: false,
        ...(typeof c.message === "string" ? { message: c.message } : {}),
      })),
    });
    return [...verdicts.map((line) => `  ${red("✗")} ${line}`), "", ...lines];
  }
  if (!r || !Array.isArray(r.checks)) return [];
  const lines = r.checks.map((c: { name?: unknown; ok?: unknown; message?: unknown }) => {
    const mark = c.ok ? green("✓") : red("✗");
    return `  ${mark} ${String(c.name ?? "check")}${typeof c.message === "string" && c.message ? `: ${c.message}` : ""}`;
  });
  if (typeof r.qualificationScore === "number") {
    lines.push(`  ${dim(`qualification score ${r.qualificationScore.toFixed(1)}`)}`);
  }
  return lines;
}
