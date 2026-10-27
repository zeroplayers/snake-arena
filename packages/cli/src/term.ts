import { styleText } from "node:util";

// styleText drops the colours when stdout isn't a TTY or NO_COLOR / NODE_DISABLE_COLORS is set.
type Format = Parameters<typeof styleText>[0];
const style =
  (format: Format) =>
  (text: string): string =>
    styleText(format, text, { stream: process.stdout });

export const bold = style("bold");
export const dim = style("dim");
export const red = style("red");
export const green = style("green");
export const yellow = style("yellow");
export const cyan = style("cyan");

/** Whether stderr shows colours (for esbuild's own messages). */
export function stderrHasColor(): boolean {
  return process.stderr.isTTY === true && !process.env.NO_COLOR && process.stderr.hasColors();
}
