/**
 * What the checks consumer writes to `versions.report`: the site's `CheckReport`
 * (`@zerosnake/web/shared`, read by the CLI and the bot pages) with the suite's own report and
 * its text alongside, so nothing the suite found is lost.
 */
import { type CheckId, formatReport, type CheckReport as SuiteReport } from "@zerosnake/checks";
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
  | "bot_archived";

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
export function failureReport(reason: FailureReason): VersionReport {
  return {
    ok: false,
    checks: [{ name: "deploy", ok: false, message: FAILURE_MESSAGES[reason] }],
    reason,
  };
}

const FAILURE_MESSAGES: Record<FailureReason, string> = {
  checks_failed_to_complete:
    "The checks didn't finish. Most likely the bot is too slow: the checks have to run within " +
    "the server's CPU limit. Run `zerosnake test` to see how long they take; if they pass " +
    "quickly there, deploy again.",
  bot_archived: "The bot was archived before the checks ended.",
};
