import { useState } from "react";
import type { OwnTrace } from "../queries/trace";
import type { ReplayTrace } from "../server/traces";
import { TRACE_RETENTION_DAYS, type TraceTick, traceTicks } from "../shared/trace";

/** Ticks shown before "Show all". */
const SHOWN_TICKS = 20;

/**
 * The selected life's trace under the replay (#25): what the bot saw, returned, spent and logged
 * before it died. Only its owner gets one; everyone else sees why not.
 */
export function TracePanel({
  trace,
  onSeek,
}: {
  trace: ReplayTrace | null;
  /** Shows a room tick in the viewer. */
  onSeek?: (tick: number) => void;
}) {
  return (
    <section className="trace" aria-labelledby="trace-title">
      <h2 className="subtitle" id="trace-title">
        Death context
      </h2>
      {trace === null ? (
        <p className="muted">Loading the trace…</p>
      ) : trace.status === "private" ? (
        <p className="muted">
          The bot's owner sees what it saw, returned and logged on its last ticks here
          {trace.signedIn ? "." : ": sign in if that's you."} Traces hold the author's own logs, so
          they are private.
        </p>
      ) : trace.status === "none" ? (
        <p className="muted">No trace was recorded for this life.</p>
      ) : trace.status === "expired" ? (
        <p className="muted">
          This life's trace is gone: traces are kept {TRACE_RETENTION_DAYS} days.
        </p>
      ) : (
        <TraceDetails trace={trace.trace} {...(onSeek && { onSeek })} />
      )}
    </section>
  );
}

function TraceDetails({ trace, onSeek }: { trace: OwnTrace; onSeek?: (tick: number) => void }) {
  const [all, setAll] = useState(false);
  const ticks = all ? traceTicks(trace) : trace.full.slice(-SHOWN_TICKS);
  const { totals, budget } = trace;
  const older = trace.sampled.length + trace.events.length;
  return (
    <>
      <p className="muted small">
        Only you see this (kept {TRACE_RETENTION_DAYS} days). Also in the terminal:{" "}
        <code>zerosnake logs --life {trace.lifeId}</code>
      </p>
      <dl className="facts">
        <div>
          <dt>Bot calls</dt>
          <dd>{totals.ticks}</dd>
        </div>
        <div>
          <dt>Errors</dt>
          <dd className={totals.errors ? "red" : undefined}>{totals.errors}</dd>
        </div>
        <div>
          <dt>Timeouts</dt>
          <dd className={totals.timeouts ? "red" : undefined}>{totals.timeouts}</dd>
        </div>
        <div>
          <dt>Peak cost</dt>
          <dd>{percent(totals.maxWork, budget.work)}</dd>
        </div>
        <div>
          <dt>Mean cost</dt>
          <dd>{percent(totals.ticks ? totals.sumWork / totals.ticks : 0, budget.work)}</dd>
        </div>
        {trace.killerName && (
          <div>
            <dt>Killed by</dt>
            <dd>{trace.killerName}</dd>
          </div>
        )}
      </dl>
      {trace.restarts.length > 0 && (
        <p className="warning">
          The room restarted while this life ran (room tick {trace.restarts.join(", ")}): the bot
          ran <code>init</code> again there with empty memory.
        </p>
      )}
      {(trace.load.error || trace.load.log.length > 0) && (
        <pre className="trace-log">
          {trace.load.log.join("\n")}
          {trace.load.error && <span className="red">{`\n${trace.load.error}`}</span>}
        </pre>
      )}
      <div className="table-scroll">
        <table className="table trace-table">
          <thead>
            <tr>
              <th>Tick</th>
              <th>Saw</th>
              <th>Returned</th>
              <th className="num">Cost</th>
              <th>log()</th>
            </tr>
          </thead>
          <tbody>
            {ticks.map((t) => (
              <TraceRow key={t.tick} tick={t} work={budget.work} {...(onSeek && { onSeek })} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        {all
          ? trace.sampleEvery === 1
            ? "Before the last 100 ticks, logs are cut short."
            : `Before the last 100 ticks: one tick in ${trace.sampleEvery}, plus the latest errors and timeouts, logs cut short.`
          : `The last ${ticks.length} of ${trace.full.length} ticks kept in full${older ? `, ${older} older ones downsampled` : ""}.`}{" "}
        <button type="button" className="button small ghost" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : "Show all"}
        </button>
      </p>
    </>
  );
}

function TraceRow({
  tick,
  work,
  onSeek,
}: {
  tick: TraceTick;
  work: number;
  onSeek?: (tick: number) => void;
}) {
  const s = tick.seen;
  return (
    <tr>
      <td>
        {onSeek ? (
          <button
            type="button"
            className="link-button"
            title={`Show room tick ${tick.tick}`}
            onClick={() => onSeek(tick.tick)}
          >
            {tick.lifeTick}
          </button>
        ) : (
          tick.lifeTick
        )}
      </td>
      <td className="small">
        wall {s.wall}
        {s.nearest && (
          <>
            {" · "}
            <span className={s.nearest.gap < 1 ? "red" : undefined}>
              @{s.nearest.author} at {s.nearest.gap}
            </span>
          </>
        )}
        {` · food ${s.food}`}
        {s.foodDist !== null && ` (${s.foodDist})`}
      </td>
      <td className="small">
        turn {tick.turn}
        {tick.boost && " boost"}
      </td>
      <td className="num small">
        {percent(tick.work, work)}
        <span className="muted"> · {tick.ops} ops</span>
      </td>
      <td>
        {tick.outcome !== "ok" && (
          <div className="red small">
            {tick.outcome}
            {tick.error && `: ${tick.error}`}
          </div>
        )}
        {tick.log.length > 0 && (
          <pre className="trace-log">
            {tick.log.join("\n")}
            {tick.logCut && <span className="muted">{"\n…"}</span>}
          </pre>
        )}
      </td>
    </tr>
  );
}

function percent(n: number, of: number): string {
  if (of <= 0) return "–";
  const p = (100 * n) / of;
  return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}
