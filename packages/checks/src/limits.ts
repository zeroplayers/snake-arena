import { utf8Length } from "@zerosnake/sdk";

/**
 * Upload limits (SPEC §6). Sizes are binary: 1 MB = 1 MiB, 256 KB = 256 KiB. The deploy API
 * should import these instead of repeating them, so the CLI and the server never disagree.
 */
export const LIMITS = Object.freeze({
  /** Files in the source archive. */
  maxSourceFiles: 50,
  /** Total size of the source archive's files. */
  maxSourceBytes: 1024 * 1024,
  /** Size of the bundled ESM file (UTF-8). */
  maxBundleBytes: 256 * 1024,
});

/** One file of the uploaded sources (`src/` of the bot project). */
export interface SourceFile {
  /** Path relative to the project, `/`-separated. Only used in messages. */
  path: string;
  bytes: number;
}

export interface LimitsDetails {
  sourceFiles: number;
  sourceBytes: number;
  bundleBytes: number;
  /** The largest source files, biggest first (at most 5), when a source limit is exceeded. */
  largest: SourceFile[];
}

export interface LimitProblem {
  limit: "sourceFiles" | "sourceBytes" | "bundleBytes";
  actual: number;
  max: number;
}

/** Measures the artifact against {@link LIMITS}. */
export function measureLimits(
  bundle: string,
  sources: readonly SourceFile[],
): { details: LimitsDetails; problems: LimitProblem[] } {
  const sourceBytes = sources.reduce((sum, f) => sum + f.bytes, 0);
  const bundleBytes = utf8Length(bundle);
  const problems: LimitProblem[] = [];
  if (sources.length > LIMITS.maxSourceFiles) {
    problems.push({ limit: "sourceFiles", actual: sources.length, max: LIMITS.maxSourceFiles });
  }
  if (sourceBytes > LIMITS.maxSourceBytes) {
    problems.push({ limit: "sourceBytes", actual: sourceBytes, max: LIMITS.maxSourceBytes });
  }
  if (bundleBytes > LIMITS.maxBundleBytes) {
    problems.push({ limit: "bundleBytes", actual: bundleBytes, max: LIMITS.maxBundleBytes });
  }
  const sourceProblem = problems.some((p) => p.limit !== "bundleBytes");
  const largest = sourceProblem
    ? [...sources]
        .sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .slice(0, 5)
        .map((f) => ({ path: f.path, bytes: f.bytes }))
    : [];
  return {
    details: { sourceFiles: sources.length, sourceBytes, bundleBytes, largest },
    problems,
  };
}

/** `812 B`, `14.2 KiB`, `256 KiB`, `1.05 MiB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${trim((bytes / 1024).toFixed(1))} KiB`;
  return `${trim((bytes / (1024 * 1024)).toFixed(2))} MiB`;
}

function trim(fixed: string): string {
  return fixed.replace(/\.0+$/, "");
}
