import { useState } from "react";
import type { Sources } from "../queries/sources";
import { Empty } from "./PageState";

/** Opened first when present: the template's entry point. */
const MAIN = /^(src\/)?bot\.[jt]sx?$/;

/**
 * A version's source files, read-only. Content is user-written code and is only ever rendered
 * as React text (escaped), with no highlighting, linkifying or HTML.
 */
export function SourceFiles({ sources }: { sources: Sources | null }) {
  const [open, setOpen] = useState(() =>
    sources?.status === "ok"
      ? Math.max(
          0,
          sources.files.findIndex((f) => MAIN.test(f.path)),
        )
      : 0,
  );
  if (sources === null || sources.status === "missing") {
    return <Empty>Sources aren't available for this version.</Empty>;
  }
  if (sources.status === "invalid") {
    return <Empty>The stored sources couldn't be read.</Empty>;
  }
  if (sources.files.length === 0) return <Empty>This version has no source files.</Empty>;
  const file = sources.files[Math.min(open, sources.files.length - 1)];
  if (!file) return null;
  return (
    <div className="sources">
      <div className="source-tabs" role="tablist" aria-label="Source files">
        {sources.files.map((f, i) => (
          <button
            key={f.path}
            type="button"
            role="tab"
            aria-selected={f === file}
            className={f === file ? "source-tab active" : "source-tab"}
            onClick={() => setOpen(i)}
          >
            {f.path}
          </button>
        ))}
      </div>
      {file.bidi && (
        <p className="warning">
          This file contains bidirectional control characters: the text may not read the way the
          code runs.
        </p>
      )}
      <pre className="source-code" role="tabpanel">
        <code>{file.content}</code>
      </pre>
      {file.truncated && <p className="muted">File cut for display.</p>}
    </div>
  );
}
