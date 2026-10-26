/**
 * BigInt literals, matched loosely: also inside strings and comments, so bot code can never hide
 * one from this check. A false positive only rejects a bot with a clear message.
 */
const BIGINT_LITERAL =
  /(?<![\w$])(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|\d[\d_]*)n(?![\w$])/;

/**
 * Static checks on a bot bundle before it is evaluated. Returns a message, or `null` if the
 * source is acceptable.
 *
 * BigInt is removed from the sandbox (its arithmetic runs in C without interrupt checks:
 * `7n ** 300000n` takes ~0.5 s), but QuickJS still parses BigInt literals, so they are rejected
 * here. `eval` and `new Function` are blocked inside the sandbox, so this check covers all code.
 */
export function checkSource(source: string): string | null {
  const match = BIGINT_LITERAL.exec(source);
  if (match) {
    const line = source.slice(0, match.index).split("\n").length;
    return `BigInt is not available to bots (found "${match[0]}" on line ${line})`;
  }
  return null;
}
