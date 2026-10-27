import { useState } from "react";
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
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
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

/** "Copy prompt for Claude": copies the prompt, or shows it selected when copying fails. */
export function CopyPromptButton({ className }: { className: string }) {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        copyText(claudePrompt()).then((ok) => {
          if (!ok) showPromptSelected();
          setState(ok ? "copied" : "manual");
          setTimeout(() => setState("idle"), 3000);
        });
      }}
    >
      <span aria-live="polite">
        {state === "copied"
          ? "Copied! Paste in Claude"
          : state === "manual"
            ? "Selected below: copy it"
            : "Copy prompt for Claude"}
      </span>
    </button>
  );
}

/**
 * The "Start with Claude" part of the quick start: what the prompt does, the prompt itself to read
 * before copying, and the copy button. Before the prompt can work (no npm package, no public
 * source) it shows the text with "Coming at launch" and no button.
 */
export function ClaudePromptBlock() {
  const works = claudePromptWorks();
  return (
    <div className="claude-start">
      <div className="start-head">
        <h3 className="start-part-title">Start with Claude</h3>
        {works ? (
          <CopyPromptButton className="button small" />
        ) : (
          <span className="soon-tag">Coming at launch</span>
        )}
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
