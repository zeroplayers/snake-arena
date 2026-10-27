import { useEffect, useRef, useState } from "react";
import { claudePrompt, claudePromptWorks } from "./claudePrompt";

/** The prompt block's `<details>` and `<pre>`, so a failed copy can show and select the text. */
const DETAILS_ID = "claude-prompt";
const TEXT_ID = "claude-prompt-text";

/**
 * Copies `text`: the Clipboard API where there is one (it needs a secure context and, on some
 * phones, permission), else a hidden textarea and `execCommand("copy")`. False when neither works.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied or unavailable: try the old way.
  }
  const focused = document.activeElement;
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    // In view and at 16px, so iOS neither scrolls to it nor zooms in.
    Object.assign(area.style, { position: "fixed", top: "0", left: "0", fontSize: "16px" });
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  } finally {
    if (focused instanceof HTMLElement) focused.focus();
  }
}

/** Opens the prompt block, scrolls to it and selects its text, for copying by hand. */
function showPromptSelected() {
  const details = document.getElementById(DETAILS_ID);
  const text = document.getElementById(TEXT_ID);
  if (!(details instanceof HTMLDetailsElement) || !text) return;
  details.open = true;
  details.scrollIntoView({ block: "center" });
  const range = document.createRange();
  range.selectNodeContents(text);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/**
 * A button that copies `text` and says so for a few seconds, in a live region. When copying
 * fails it says `failed` (after `onFail`, which can show the text to copy by hand).
 */
export function CopyButton({
  text,
  label,
  copied = "Copied!",
  failed = "Couldn't copy: select it instead",
  onFail,
  className,
}: {
  text: () => string;
  label: string;
  copied?: string;
  failed?: string;
  onFail?: () => void;
  className: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(reset.current), []);
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        clearTimeout(reset.current);
        copyText(text()).then((ok) => {
          if (!ok) onFail?.();
          setState(ok ? "copied" : "failed");
          reset.current = setTimeout(() => setState("idle"), 3000);
        });
      }}
    >
      <span aria-live="polite">
        {state === "copied" ? copied : state === "failed" ? failed : label}
      </span>
    </button>
  );
}

/** "Copy prompt for Claude": copies the prompt, or shows it selected when copying fails. */
export function CopyPromptButton({ className }: { className: string }) {
  return (
    <CopyButton
      className={className}
      text={() => claudePrompt()}
      label="Copy prompt for Claude"
      copied="Copied! Paste in Claude"
      failed="Selected below: copy it"
      onFail={showPromptSelected}
    />
  );
}

/**
 * The "Start with Claude" part of the quick start: what the prompt does, the prompt itself to read
 * before copying, and the copy button. Before the prompt can work (no npm package, no public
 * source) it only says what will be here: a runnable `npx zerosnake` prompt today would run
 * whatever package squats that name.
 */
export function ClaudePromptBlock() {
  if (!claudePromptWorks()) {
    return (
      <div className="claude-start">
        <div className="start-head">
          <h3 className="start-part-title">Start with Claude</h3>
          <span className="soon-tag">Coming at launch</span>
        </div>
        <p className="muted small">
          On launch day a button here copies one prompt for{" "}
          <a href="https://claude.com/claude-code">Claude Code</a> (or any coding agent). Pasted
          into an empty folder, it creates your bot, explains it, writes a first strategy, tests it,
          and walks you through signing in with GitHub and deploying. It needs the{" "}
          <code>zerosnake</code> package on npm, so it isn't here yet.
        </p>
      </div>
    );
  }
  return (
    <div className="claude-start">
      <div className="start-head">
        <h3 className="start-part-title">Start with Claude</h3>
        <CopyPromptButton className="button small" />
      </div>
      <p className="muted small">
        Open <a href="https://claude.com/claude-code">Claude Code</a> (or Cursor, Codex, any coding
        agent) in an empty folder and paste this prompt. It creates the bot, explains it, writes
        your first strategy, tests it, and walks you through signing in with GitHub and deploying.
      </p>
      <details id={DETAILS_ID} className="claude-prompt">
        <summary>Read the prompt</summary>
        <pre id={TEXT_ID} className="code-block prompt-text">
          {claudePrompt()}
        </pre>
      </details>
    </div>
  );
}
