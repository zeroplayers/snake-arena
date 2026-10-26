/**
 * BigInt literals, matched loosely: also inside strings and comments, so bot code can never hide
 * one from this check. A false positive only rejects a bot with a clear message.
 */
const BIGINT_LITERAL =
  /(?<![\w$])(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|\d[\d_]*)n(?![\w$])/;

/**
 * The `async` keyword, matched as a whole word anywhere. QuickJS does not accept it spelled with
 * escapes (`\u0061sync`), so this sees every async function, method, arrow and generator.
 */
const ASYNC_KEYWORD = /(?<![\w$])async(?![\w$])/;

/**
 * Static checks on a bot bundle before it is evaluated. Returns a message, or `null` if the
 * source is acceptable. `eval` and `new Function` are blocked inside the sandbox, so these checks
 * cover all code a bot can run.
 *
 * - BigInt is removed from the sandbox (its arithmetic runs in C without interrupt checks:
 *   `7n ** 300000n` takes ~0.5 s), but QuickJS still parses BigInt literals.
 * - An exception inside an async function becomes a rejected promise, including the interrupt
 *   that ends an over-budget tick, so a bot could catch it and keep running. Promise jobs never
 *   run in the sandbox (nothing after an `await` would ever execute), so async code is useless to
 *   a bot anyway.
 */
export function checkSource(source: string): string | null {
  const bigint = BIGINT_LITERAL.exec(source);
  if (bigint) {
    return `BigInt is not available to bots (found "${bigint[0]}" on line ${lineOf(source, bigint.index)})`;
  }
  const async = ASYNC_KEYWORD.exec(source);
  if (async) {
    return `async functions are not available to bots: promise jobs never run in the sandbox (found "async" on line ${lineOf(source, async.index)})`;
  }
  return null;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}
