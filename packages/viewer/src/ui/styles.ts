/**
 * Viewer styles, injected once per document. Kept in TS rather than a `.css` import so the
 * viewer works with any bundler (or none). Everything is scoped under `.zsv`.
 */
const CSS = `
.zsv {
  --zsv-bg: #07080a;
  --zsv-panel: #101216;
  --zsv-line: #23262d;
  --zsv-text: #d8dbe0;
  --zsv-dim: #858b96;
  --zsv-accent: #4cc3ff;
  --zsv-danger: #ff5d5d;
  --zsv-good: #5ee08a;
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  grid-template-rows: minmax(0, 1fr) auto;
  width: 100%;
  height: 100%;
  min-height: 360px;
  background: var(--zsv-bg);
  color: var(--zsv-text);
  font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  outline: none;
  overflow: hidden;
}
.zsv * { box-sizing: border-box; }
.zsv [hidden] { display: none !important; }
.zsv-stage { position: relative; min-width: 0; min-height: 0; background: #000; cursor: crosshair; }
.zsv-stage > canvas { position: absolute; inset: 0; width: 100% !important; height: 100% !important; }
.zsv-hud {
  position: absolute; top: 8px; left: 8px; display: flex; gap: 6px; align-items: center;
  padding: 4px 6px; background: rgb(0 0 0 / 0.55); border: 1px solid var(--zsv-line);
  border-radius: 6px; pointer-events: auto;
}
.zsv-hud-text { color: var(--zsv-dim); padding: 0 4px; white-space: nowrap; }
.zsv-btn {
  font: inherit; color: var(--zsv-text); background: #1a1d23; border: 1px solid #2e323a;
  border-radius: 5px; padding: 3px 9px; cursor: pointer; white-space: nowrap;
}
.zsv-btn:hover:not(:disabled) { background: #252932; }
.zsv-btn:disabled { opacity: 0.4; cursor: default; }
.zsv-btn[aria-pressed="true"] { border-color: var(--zsv-accent); color: var(--zsv-accent); }
.zsv-select {
  font: inherit; color: var(--zsv-text); background: #1a1d23; border: 1px solid #2e323a;
  border-radius: 5px; padding: 2px 4px;
}

.zsv-side {
  grid-row: 1 / span 2; grid-column: 2; display: flex; flex-direction: column; min-height: 0;
  background: var(--zsv-panel); border-left: 1px solid var(--zsv-line);
}
.zsv-section { padding: 10px 12px; border-bottom: 1px solid var(--zsv-line); }
.zsv-section h3 {
  margin: 0 0 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--zsv-dim);
}
.zsv-title { font-weight: 600; }
.zsv-list { overflow-y: auto; max-height: 38%; flex: none; }
.zsv-row {
  display: grid; grid-template-columns: 12px minmax(0, 1fr) auto auto; gap: 8px; align-items: center;
  width: 100%; padding: 2px 4px; border: 0; border-radius: 4px; background: none;
  color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.zsv-row:hover { background: #1a1d23; }
.zsv-row[aria-selected="true"] { background: #1d2733; }
.zsv-row.zsv-dead { color: var(--zsv-dim); }
.zsv-row .zsv-num { text-align: right; font-variant-numeric: tabular-nums; }
.zsv-row .zsv-mass { color: var(--zsv-dim); min-width: 4.5em; }
.zsv-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zsv-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 50%; flex: none; }
.zsv-sub { color: var(--zsv-dim); margin: 6px 0 2px; }

.zsv-panel { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.zsv-empty { color: var(--zsv-dim); }
.zsv-head { display: flex; gap: 8px; align-items: center; }
.zsv-status { margin: 4px 0 8px; color: var(--zsv-dim); }
.zsv-status.zsv-is-dead { color: var(--zsv-danger); }
.zsv-stats { display: grid; grid-template-columns: auto 1fr auto 1fr; gap: 2px 10px; }
.zsv-stats dt { color: var(--zsv-dim); }
.zsv-stats dd { margin: 0; font-variant-numeric: tabular-nums; }
.zsv-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.zsv-turn { display: flex; align-items: center; gap: 8px; }
.zsv-turnbar {
  position: relative; flex: 1; height: 8px; background: #1a1d23; border-radius: 4px;
  overflow: hidden;
}
.zsv-turnbar::after {
  content: ""; position: absolute; left: 50%; top: 0; bottom: 0; width: 1px; background: #3a3f48;
}
.zsv-turnfill { position: absolute; top: 0; bottom: 0; background: var(--zsv-accent); }
.zsv-boost { color: #ffb347; }
.zsv-logs {
  flex: 1; min-height: 80px; overflow-y: auto; margin: 0; padding: 6px 8px; background: #0a0b0e;
  border: 1px solid var(--zsv-line); border-radius: 5px; white-space: pre-wrap; word-break: break-word;
}
.zsv-log { color: var(--zsv-dim); }
.zsv-log.zsv-now { color: var(--zsv-text); }
.zsv-log-tick { color: #5b616b; margin-right: 6px; }
.zsv-logs-section { flex: 1; display: flex; flex-direction: column; min-height: 0; border-bottom: 0; }

.zsv-bar {
  grid-row: 2; grid-column: 1; display: flex; gap: 6px; align-items: center; padding: 8px 10px;
  background: var(--zsv-panel); border-top: 1px solid var(--zsv-line); min-width: 0;
}
.zsv-timeline { position: relative; flex: 1; min-width: 80px; height: 22px; }
.zsv-markers {
  position: absolute; inset: 0 7px; pointer-events: none; --first: 0; --span: 1;
}
.zsv-marker {
  position: absolute; left: calc((var(--t) - var(--first)) / var(--span) * 100%); top: 2px; bottom: 2px; width: 2px; margin-left: -1px; background: #4a4f58;
  border-radius: 1px;
}
.zsv-marker.zsv-mine { background: var(--zsv-danger); top: 0; bottom: 0; width: 3px; }
.zsv-marker.zsv-born { background: var(--zsv-good); top: 0; bottom: 0; width: 3px; }
.zsv-range {
  position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; background: transparent;
  accent-color: var(--zsv-accent); cursor: pointer;
}
.zsv-tick { min-width: 11ch; text-align: right; color: var(--zsv-dim); font-variant-numeric: tabular-nums; }

@media (max-width: 720px) {
  .zsv { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(240px, 1fr) auto auto; }
  .zsv-side { grid-row: 3; grid-column: 1; border-left: 0; border-top: 1px solid var(--zsv-line); max-height: 45vh; }
  .zsv-bar { flex-wrap: wrap; }
  .zsv-timeline { flex-basis: 100%; order: -1; }
}
`;

const STYLE_ID = "zerosnake-viewer-styles";

export function injectStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.append(style);
}
