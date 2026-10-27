import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSandbox } from "@zerosnake/sandbox";
import { DEPLOY_LIMITS, type DeployLimits } from "@zerosnake/web/shared";
import type { BundledBot } from "./bundle.ts";
import { CliError } from "./errors.ts";
import type { Io } from "./io.ts";
import { assertLoads } from "./preflight.ts";
import { collectSources } from "./project.ts";
import { dim, green, red } from "./term.ts";

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
 * server's (`GET /api/me`) when signed in, else the defaults.
 */
export function limitChecks(
  bundle: BundledBot,
  sources: SourceText[],
  limits: DeployLimits = DEPLOY_LIMITS,
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
  const body = Buffer.byteLength(
    JSON.stringify({
      bundle: bundle.code,
      sources: sources.map(({ path, content }) => ({ path, content })),
    }),
  );
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
 * The checks `test` and `deploy` run on this machine before anything is uploaded: the deploy
 * limits, then loading the bundle in the sandbox. Prints a line per check; throws a
 * {@link CliError} on the first failure.
 *
 * Hook for the full suite (zeroplayers/snake-arena#13, `@zerosnake/checks`): once it's on main,
 * run its `runChecks({ bundle, sources })` here after `assertLoads`, print `formatReport`, and
 * fail unless it passed. `test` and `deploy` both pick it up from here.
 */
export async function runLocalChecks(
  io: Io,
  bundle: BundledBot,
  sources: SourceText[],
  limits?: DeployLimits,
): Promise<void> {
  const limitResults = limitChecks(bundle, sources, limits);
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

  assertLoads(await createSandbox(), "Your bot", bundle.code);
  io.out(`${green("✓")} loads in the sandbox`);
}

/** Lines for a `CheckReport` (`versions.report`); tolerant of fields it doesn't know. */
export function formatReport(report: unknown): string[] {
  const r = report as { checks?: unknown; qualificationScore?: unknown } | null;
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
