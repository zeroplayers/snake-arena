/** The parts of a source map (v3) we read. */
export interface SourceMap {
  sources: string[];
  mappings: string;
}

export interface OriginalPosition {
  source: string;
  /** 1-based. */
  line: number;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Where generated `line` (1-based) came from: the source and line of its first mapped segment,
 * or `null` if nothing on that line is mapped. Enough to point an error at the author's file.
 */
export function originalPosition(map: SourceMap, line: number): OriginalPosition | null {
  // Source index and line are deltas across the whole mapping, so walk up to `line`.
  let source = 0;
  let sourceLine = 0;
  const lines = map.mappings.split(";");
  for (let l = 0; l < lines.length && l < line; l++) {
    for (const segment of (lines[l] as string).split(",")) {
      if (!segment) continue;
      const fields = decodeVlq(segment);
      if (fields.length < 4) continue;
      source += fields[1] as number;
      sourceLine += fields[2] as number;
      if (l === line - 1) {
        const file = map.sources[source];
        return file === undefined ? null : { source: file, line: sourceLine + 1 };
      }
    }
  }
  return null;
}

function decodeVlq(segment: string): number[] {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = BASE64.indexOf(char);
    if (digit < 0) throw new Error(`bad source map character "${char}"`);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
    } else {
      out.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = 0;
      shift = 0;
    }
  }
  return out;
}
