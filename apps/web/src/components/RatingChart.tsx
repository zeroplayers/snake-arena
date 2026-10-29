import { useEffect, useRef, useState } from "react";
import type { VersionRow } from "../queries/bot";
import { formatMinutes, formatRating } from "./format";

/** Width before the plot is measured (server render); the SVG then matches its box, so text
 * stays at its CSS size on a phone. */
const DEFAULT_WIDTH = 640;
const H = 200;
const PAD = { top: 16, right: 16, bottom: 28, left: 44 };

/**
 * Rating across a bot's versions: each rated version's points per minute with its 95% CI as a
 * whisker, in version order. Hollow markers are versions still under the leaderboard threshold
 * (`minMinutes` alive). The versions table next to it is the table view of the same numbers.
 */
export function RatingChart({
  versions,
  minMinutes,
}: {
  versions: VersionRow[];
  minMinutes: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const plot = useRef<HTMLDivElement>(null);
  const [W, setWidth] = useState(DEFAULT_WIDTH);
  useEffect(() => {
    const el = plot.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(240, Math.round(entry.contentRect.width)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const rated = versions
    .filter((v): v is VersionRow & { rating: number; ratingCi: number } => v.rating !== null)
    .map((v) => ({ ...v, ratingCi: v.ratingCi ?? 0 }))
    .sort((a, b) => a.n - b.n);
  if (rated.length === 0) {
    return (
      <p className="empty-block">
        No rated versions yet. A version is rated after its first lives.
      </p>
    );
  }

  const lo = Math.min(...rated.map((v) => v.rating - v.ratingCi));
  const hi = Math.max(...rated.map((v) => v.rating + v.ratingCi));
  const [y0, y1, ticks] = niceScale(lo, hi);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const step = innerW / rated.length;
  const x = (i: number) => PAD.left + step * (i + 0.5);
  const y = (v: number) => PAD.top + innerH * (1 - (v - y0) / (y1 - y0 || 1));
  const line = rated.map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v.rating)}`).join(" ");
  const active = hover === null ? undefined : rated[hover];

  return (
    <figure className="chart">
      <div className="chart-plot" ref={plot}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Rating by version: ${rated.map((v) => `v${v.n} ${formatRating(v.rating, v.ratingCi)}`).join(", ")}`}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line className="chart-grid" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
              <text className="chart-axis" x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
                {t}
              </text>
            </g>
          ))}
          <path className="chart-line" d={line} />
          {rated.map((v, i) => {
            const ranked = isRanked(v, minMinutes);
            return (
              <g key={v.id} className={hover === i ? "chart-mark active" : "chart-mark"}>
                <line
                  className="chart-whisker"
                  x1={x(i)}
                  x2={x(i)}
                  y1={y(v.rating - v.ratingCi)}
                  y2={y(v.rating + v.ratingCi)}
                />
                <circle
                  className={ranked ? "chart-dot" : "chart-dot hollow"}
                  cx={x(i)}
                  cy={y(v.rating)}
                  r={5}
                />
                <text className="chart-axis" x={x(i)} y={H - 8} textAnchor="middle">
                  v{v.n}
                </text>
              </g>
            );
          })}
        </svg>
        {/* Hit targets: one column per version, bigger than the marks; focus shows the same. */}
        {rated.map((v, i) => (
          <button
            key={v.id}
            type="button"
            className="chart-hit"
            aria-label={`v${v.n}: ${formatRating(v.rating, v.ratingCi)} pts/min over ${ratedOver(v)}`}
            style={{
              left: `${((x(i) - step / 2) / W) * 100}%`,
              width: `${(step / W) * 100}%`,
              top: `${(PAD.top / H) * 100}%`,
              height: `${(innerH / H) * 100}%`,
            }}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
          />
        ))}
      </div>
      <figcaption className="chart-caption">
        {active ? (
          <span>
            <strong>v{active.n}</strong> {formatRating(active.rating, active.ratingCi)} pts/min over{" "}
            {ratedOver(active)}
            {isRanked(active, minMinutes) ? "" : " (unranked)"}
          </span>
        ) : (
          <span className="muted">
            Points per minute alive with 95% CI. Hollow: alive under {minMinutes} minutes in all,
            not on the leaderboard yet.
          </span>
        )}
      </figcaption>
    </figure>
  );
}

/** Whether a version is on the leaderboard's side of the threshold (status aside). */
export function isRanked(
  v: Pick<VersionRow, "ratedLives" | "ratedMinutes">,
  minMinutes: number,
): boolean {
  return (v.ratedLives ?? 0) >= 2 && (v.ratedMinutes ?? 0) >= minMinutes;
}

/** `12 lives, 3 h 05 min alive`. */
export function ratedOver(v: Pick<VersionRow, "ratedLives" | "ratedMinutes">): string {
  const lives = v.ratedLives ?? 0;
  return `${lives} ${lives === 1 ? "life" : "lives"}, ${formatMinutes(v.ratedMinutes ?? 0)} alive`;
}

/** Rounded bounds and 3–5 gridlines covering `[lo, hi]`. */
export function niceScale(lo: number, hi: number): [number, number, number[]] {
  if (!(hi > lo)) {
    lo -= 1;
    hi += 1;
  }
  const raw = (hi - lo) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const unit = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const y0 = Math.floor(lo / unit) * unit;
  const y1 = Math.ceil(hi / unit) * unit;
  const ticks: number[] = [];
  for (let t = y0; t <= y1 + unit / 2; t += unit) ticks.push(Number(t.toFixed(6)));
  return [y0, y1, ticks];
}
