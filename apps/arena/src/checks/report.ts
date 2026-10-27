/**
 * What the checks consumer writes to `versions.report`: the site's `CheckReport`
 * (`@zerosnake/web/shared`, read by the CLI and the bot pages) with the suite's own report and
 * its text alongside, so nothing the suite found is lost.
 */
import {
  type CheckId,
  formatBytes,
  formatReport,
  type CheckReport as SuiteReport,
} from "@zerosnake/checks";
import type { CheckReport } from "@zerosnake/web/shared";

export interface VersionReport extends CheckReport {
  /** The suite's full report (`@zerosnake/checks`, its own `version` field), when it ran. */
  suite?: SuiteReport;
  /** `formatReport(suite)`: what `zerosnake test` prints for the same bundle. */
  text?: string;
  /** Set when the consumer, not the suite, ended the version. */
  reason?: FailureReason;
}

export type FailureReason =
  /** Every delivery of the job died or failed (CPU limit, or an error on our side). */
  | "checks_failed_to_complete"
  /** The bot was archived while the version was being checked. */
  | "bot_archived"
  /** The bundle or the source archive isn't in R2. */
  | "input_missing"
  /** The source archive isn't `zerosnake-sources@1` JSON. */
  | "input_malformed"
  /** An R2 object is over the upload limits, so it wasn't read (a `limits` check). */
  | "input_too_large"
  /** The deploy request died before queueing the job; the reaper ended the version. */
  | "enqueue_failed";

/** The suite's check ids as `CheckReport` names (the ones `checkReportLines` has labels for). */
const NAMES: Record<CheckId, string> = {
  limits: "limits",
  load: "loads",
  run: "seeds",
  qualify: "qualification",
};

const ORDER: CheckId[] = ["limits", "load", "run", "qualify"];

/** The suite's report as a `versions.report`. Skipped checks are left out. */
export function versionReport(suite: SuiteReport): VersionReport {
  const checks: CheckReport["checks"] = [];
  for (const id of ORDER) {
    const check = suite[id];
    if (check.status === "skip") continue;
    const ok = check.status === "pass";
    checks.push({
      name: NAMES[id],
      ok,
      message: ok || !check.hint ? check.summary : `${check.summary}. ${check.hint}`,
    });
  }
  const report: VersionReport = { ok: suite.passed, checks, suite, text: formatReport(suite) };
  if (suite.qualify.score !== null) report.qualificationScore = suite.qualify.score;
  return report;
}

/** A report for a version the consumer ended without a verdict from the suite. */
export function failureReport(reason: Exclude<FailureReason, "input_too_large">): VersionReport {
  return {
    ok: false,
    checks: [{ name: "deploy", ok: false, message: FAILURE_MESSAGES[reason] }],
    reason,
  };
}

/**
 * A failed `limits` check for an upload the consumer didn't read: `size` bytes of `what` in R2,
 * over `max` (from `LIMITS`, of `maxOf` when that isn't `what`).
 */
export function tooLargeReport(
  what: string,
  size: number,
  max: number,
  maxOf?: string,
): VersionReport {
  // Exact bytes when rounding would make the size look like the limit, as the suite does.
  const actual = formatBytes(size) === formatBytes(max) ? `${size} B` : formatBytes(size);
  const limit = maxOf ? `${formatBytes(max)} of ${maxOf}` : formatBytes(max);
  return {
    ok: false,
    checks: [
      {
        name: "limits",
        ok: false,
        message: `over the upload limits: ${what} is ${actual} (max ${limit})`,
      },
    ],
    reason: "input_too_large",
  };
}

const FAILURE_MESSAGES: Record<Exclude<FailureReason, "input_too_large">, string> = {
  checks_failed_to_complete:
    "The checks didn't finish. Most likely the bot is too slow: the checks have to run within " +
    "the server's CPU limit. Run `zerosnake test` to see how long they take; if they pass " +
    "quickly there, deploy again.",
  bot_archived: "The bot was archived before the checks ended.",
  input_missing: "The upload wasn't found on the server. Deploy again.",
  input_malformed:
    "The uploaded sources couldn't be read. Deploy again with the latest `zerosnake` CLI.",
  enqueue_failed: "This deploy was interrupted before its checks were queued. Deploy again.",
};
