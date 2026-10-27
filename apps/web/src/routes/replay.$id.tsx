import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { DEATH_CAUSES, formatDateTime, formatTicks } from "../components/format";
import { Empty, PageError, PagePending } from "../components/PageState";
import { ReplayViewer } from "../components/ReplayViewer";
import { TracePanel } from "../components/TracePanel";
import { getReplayPage } from "../server/pages";
import { getReplayTrace, type ReplayTrace } from "../server/traces";
import { REPLAY_EXPIRED_MESSAGE } from "../shared/replay";

/** `/replay/{lifeId}`: the room replay around one life, with that snake selected. */
export const Route = createFileRoute("/replay/$id")({
  loader: async ({ params }) => {
    const life = await getReplayPage({ data: params.id });
    if (!life) throw notFound();
    return life;
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData
          ? `Replay: ${loaderData.botName} v${loaderData.version} by @${loaderData.author} · ZeroSnake Arena`
          : "Replay · ZeroSnake Arena",
      },
    ],
  }),
  component: ReplayPage,
  pendingComponent: PagePending,
  errorComponent: PageError,
});

function ReplayPage() {
  const life = Route.useLoaderData();
  const ticks = life.endTick === null ? null : life.endTick - life.startTick;
  const trace = useTrace(life.id, life.endedAt !== null);
  const seek = useRef<((tick: number) => void) | null>(null);
  return (
    <section className="panel replay">
      <p className="breadcrumbs muted">
        <Link to="/@{$username}" params={{ username: life.author }}>
          @{life.author}
        </Link>{" "}
        /{" "}
        <Link
          to="/@{$username}/$bot"
          params={{ username: life.author, bot: life.botSlug }}
          search={{ v: life.version }}
        >
          {life.botName} v{life.version}
        </Link>{" "}
        / replay
      </p>
      <h1 className="title">
        {life.deathCause ? (
          <>
            Died: <span className="red">{DEATH_CAUSES[life.deathCause]}</span>
          </>
        ) : (
          "Still alive"
        )}
      </h1>
      <dl className="facts">
        <div>
          <dt>Score</dt>
          <dd>{life.score}</dd>
        </div>
        <div>
          <dt>Kills</dt>
          <dd>{life.kills}</dd>
        </div>
        <div>
          <dt>Lived</dt>
          <dd>{formatTicks(ticks)}</dd>
        </div>
        {life.endedAt && (
          <div>
            <dt>Ended</dt>
            <dd>{formatDateTime(life.endedAt)}</dd>
          </div>
        )}
      </dl>
      {life.replayExpired ? (
        <Empty>{REPLAY_EXPIRED_MESSAGE}</Empty>
      ) : life.replayRecorded ? (
        <ReplayViewer
          lifeId={life.id}
          title={`${life.botName} v${life.version} · @${life.author}`}
          trace={trace}
          seek={seek}
        />
      ) : (
        <Empty>No recording was kept for this life.</Empty>
      )}
      {life.endedAt && (
        <TracePanel
          trace={trace}
          // Rows jump to their tick in the player; without a replay there's nothing to jump in.
          {...(life.replayRecorded &&
            !life.replayExpired && { onSeek: (tick: number) => seek.current?.(tick) })}
        />
      )}
    </section>
  );
}

/** The life's trace, fetched after the page loads (it depends on who is looking). */
function useTrace(lifeId: string, ended: boolean): ReplayTrace | null {
  const [trace, setTrace] = useState<ReplayTrace | null>(null);
  useEffect(() => {
    if (!ended) return;
    let cancelled = false;
    setTrace(null);
    getReplayTrace({ data: lifeId })
      .then((t) => {
        if (!cancelled) setTrace(t);
      })
      .catch(() => {
        if (!cancelled) setTrace({ status: "none" });
      });
    return () => {
      cancelled = true;
    };
  }, [lifeId, ended]);
  return trace;
}
