/**
 * Max UTF-8 bytes of `log()` output kept per tick, across all calls in that tick.
 *
 * Truncation: each `log(...)` call becomes one line. Lines are kept in order until the next
 * one would go over the limit; that line is cut at a character boundary and ends with `…`,
 * and every later call in the same tick is dropped. The budget resets every tick.
 */
export const LOG_LIMIT_BYTES = 1024;

/**
 * The `log` function passed to `tick()`. Works like `console.log`: arguments are joined with
 * spaces, strings print as-is, everything else as JSON (`String()` if JSON fails).
 * Output is capped at {@link LOG_LIMIT_BYTES} per tick; see there for how it is truncated.
 */
export type LogFn = (...args: unknown[]) => void;

/** Ellipsis marker appended to a cut line (3 UTF-8 bytes). */
const CUT_MARK = "…";
const CUT_MARK_BYTES = 3;

/**
 * One tick's worth of log output. For runners (sandbox, CLI), not bot authors.
 */
export interface TickLog {
  /** Pass this to `tick()`. */
  log: LogFn;
  /** Returns the lines logged since the last call and resets the budget for the next tick. */
  flush(): { lines: string[]; truncated: boolean };
}

/**
 * Creates the per-tick logger used by the sandbox and the CLI, so truncation behaves the same
 * everywhere. For runners, not bot authors. Pure JS: runs inside QuickJS (no `TextEncoder`).
 *
 * @param limitBytes - Byte budget per tick. Defaults to {@link LOG_LIMIT_BYTES}.
 */
export function createTickLog(limitBytes: number = LOG_LIMIT_BYTES): TickLog {
  let lines: string[] = [];
  let used = 0;
  let truncated = false;

  // Bytes are counted per line; the newline between lines is not counted.
  const log: LogFn = (...args) => {
    if (truncated) return;
    const line = args.map(formatArg).join(" ");
    const size = utf8Length(line);
    if (used + size <= limitBytes) {
      lines.push(line);
      used += size;
      return;
    }
    truncated = true;
    const room = limitBytes - used - CUT_MARK_BYTES;
    if (room >= 0) lines.push(cutUtf8(line, room) + CUT_MARK);
  };

  return {
    log,
    flush() {
      const out = { lines, truncated };
      lines = [];
      used = 0;
      truncated = false;
      return out;
    },
  };
}

function formatArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  try {
    const json = JSON.stringify(arg);
    if (json !== undefined) return json;
  } catch {
    // circular or BigInt: fall through
  }
  return String(arg);
}

/** UTF-8 byte length of a string, without `TextEncoder`. Lone surrogates count as 3 bytes. */
export function utf8Length(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && isLowSurrogate(s.charCodeAt(i + 1))) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** Longest prefix of `s` that fits in `maxBytes` UTF-8 bytes, never splitting a code point. */
function cutUtf8(s: string, maxBytes: number): string {
  let bytes = 0;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    let size = 3;
    let units = 1;
    if (c < 0x80) size = 1;
    else if (c < 0x800) size = 2;
    else if (c >= 0xd800 && c <= 0xdbff && isLowSurrogate(s.charCodeAt(i + 1))) {
      size = 4;
      units = 2;
    }
    if (bytes + size > maxBytes) break;
    bytes += size;
    i += units;
  }
  return s.slice(0, i);
}

function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}
