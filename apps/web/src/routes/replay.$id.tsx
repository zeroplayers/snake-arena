import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { DEATH_CAUSES, formatDateTime, formatTicks } from "../components/format";
import { Empty, PageError, PagePending } from "../components/PageState";
import { ReplayViewer } from "../components/ReplayViewer";
import { getReplayPage } from "../server/pages";

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
      {life.hasReplay ? (
        <ReplayViewer
          lifeId={life.id}
          title={`${life.botName} v${life.version} · @${life.author}`}
        />
      ) : (
        <Empty>No recording was kept for this life.</Empty>
      )}
    </section>
  );
}
