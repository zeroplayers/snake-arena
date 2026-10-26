import type { CheckId, CheckReport, CheckStatus } from "./report.ts";

const MARK: Record<CheckStatus, string> = { pass: "✓", fail: "✗", skip: "-" };
const INDENT = "    ";
/** Width of the mark and check name column; wrapped lines are indented to it. */
const LABEL = " ".repeat(12);

/**
 * Renders a report for a person: one line per check, then what to fix. The CLI prints it as is
 * for `zerosnake test` and for a rejected deploy.
 */
export function formatReport(report: CheckReport): string {
  const out: string[] = [];
  out.push(
    report.passed
      ? "Checks passed: this bot can be deployed."
      : "Checks failed: this bot would be rejected.",
  );
  out.push("");

  const rows: [string, CheckReport[CheckId]][] = [
    ["Limits", report.limits],
    ["Loads", report.load],
    ["Runs", report.run],
    ["Qualifies", report.qualify],
  ];
  for (const [title, check] of rows) {
    const [first = "", ...rest] = wrap(check.summary, LABEL);
    out.push(`${MARK[check.status]} ${title.padEnd(LABEL.length - 2)}${first.slice(LABEL.length)}`);
    out.push(...rest);
    if (check.hint) out.push(...wrap(`What to fix: ${check.hint}`, LABEL));
  }

  const { fault, warnings } = report.run;
  if (fault && fault.log.length > 0) {
    out.push("", `Last log lines before it died (seed ${fault.seed}, tick ${fault.tick}):`);
    for (const line of fault.log) out.push(`${INDENT}${line}`);
  }
  if (warnings.length > 0) {
    out.push("", "Warnings:");
    for (const w of warnings) {
      const [first = "", ...rest] = wrap(w, INDENT);
      out.push(`  - ${first.slice(INDENT.length)}`, ...rest);
    }
  }

  const q = report.qualify;
  if (q.status !== "skip") {
    out.push("", "Mean score per life, you vs easy in your seat:");
    for (const s of q.perSeed) {
      const run = report.run.seeds.find((r) => r.seed === s.seed);
      const ends = run
        ? Object.entries(run.ends)
            .map(([end, n]) => `${end === "window" ? "alive at the end" : end} ${n}`)
            .join(", ")
        : "";
      out.push(
        `${INDENT}seed ${String(s.seed).padEnd(10)} ${fmt(s.score).padStart(9)} vs ${fmt(s.bar).padStart(9)}   lives: ${ends}`,
      );
    }
  }
  const setup = `(${report.seeds.length} seeds × ${report.ticks} ticks against easy, medium, hard and chaos; budget ${report.opBudget} ops per tick, at most half of it on average)`;
  out.push("", ...wrap(setup, ""));
  return `${out.join("\n")}\n`;
}

function fmt(x: number): string {
  return x.toFixed(1);
}

/** Word-wraps `text` to 100 columns, every line prefixed by `indent`. */
function wrap(text: string, indent: string): string[] {
  const width = 100 - indent.length;
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(indent + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(indent + line);
  return lines;
}
