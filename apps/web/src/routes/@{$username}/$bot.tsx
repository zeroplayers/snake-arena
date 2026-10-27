import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  DEATH_CAUSES,
  formatDate,
  formatDateTime,
  formatRating,
  formatTicks,
} from "../../components/format";
import { Empty, PageError, PagePending } from "../../components/PageState";
import { RatingChart } from "../../components/RatingChart";
import { SourceFiles } from "../../components/SourceFiles";
import type { Killer, LifeRow, VersionRow } from "../../queries/bot";
import type { Sources } from "../../queries/sources";
import { getBotPageData, getVersionSources } from "../../server/pages";

interface BotSearch {
  /** Version number whose lives and sources are shown. */
  v?: number;
  /** Page of the versions table. */
  page?: number;
}

export const Route = createFileRoute("/@{$username}/$bot")({
  validateSearch: (search: Record<string, unknown>): BotSearch => {
    const v = Number(search.v);
    const page = Number(search.page);
    return {
      ...(Number.isInteger(v) && v >= 1 && { v }),
      ...(Number.isInteger(page) && page > 1 && page <= 1000 && { page }),
    };
  },
  loaderDeps: ({ search }) => ({ v: search.v, page: search.page }),
  loader: async ({ params, deps }) => {
    const page = await getBotPageData({
      data: {
        username: params.username,
        bot: params.bot,
        ...(deps.v !== undefined && { version: deps.v }),
        ...(deps.page !== undefined && { page: deps.page }),
      },
    });
    if (!page) throw notFound();
    return page;
  },
  head: ({ params }) => ({
    meta: [{ title: `${params.bot} by @${params.username} · ZeroSnake Arena` }],
  }),
  component: BotPage,
  pendingComponent: PagePending,
  errorComponent: PageError,
});

const STATUS: Record<VersionRow["status"], string> = {
  ready: "active",
  validating: "checking",
  rejected: "rejected",
  archived: "archived",
};

function BotPage() {
  const page = Route.useLoaderData();
  const { author, bot, versions, selected, minLives, active, hasOlder } = page;
  const versionsPage = page.page;
  const paged = hasOlder || versionsPage > 1;
  const pageSearch = versionsPage > 1 ? { page: versionsPage } : {};

  return (
    <>
      <section className="panel">
        <p className="breadcrumbs muted">
          <Link to="/@{$username}" params={{ username: author.username }}>
            @{author.username}
          </Link>{" "}
          /
        </p>
        <h1 className="title">{bot.name}</h1>
        <p className="muted">
          {bot.archivedAt ? (
            <>Archived by its author on {formatDate(bot.archivedAt)}.</>
          ) : active ? (
            <>
              Active: <span className="accent">v{active.n}</span>, rated{" "}
              {formatRating(active.rating, active.ratingCi)}
            </>
          ) : (
            "No active version."
          )}{" "}
          · Created {formatDate(bot.createdAt)}
        </p>
      </section>

      <section className="panel">
        <h2 className="subtitle">
          Rating by version
          {paged && versions.length > 0 && (
            <span className="muted small">
              {" "}
              v{versions.at(-1)?.n}–v{versions[0]?.n}
            </span>
          )}
        </h2>
        <RatingChart versions={versions} minLives={minLives} />
      </section>

      <section className="panel">
        <h2 className="subtitle">Versions</h2>
        {versions.length === 0 ? (
          <Empty>
            {versionsPage > 1 ? (
              "No versions on this page."
            ) : (
              <>
                No versions yet. <code>npx zerosnake deploy</code> uploads the first one.
              </>
            )}
          </Empty>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Status</th>
                  <th className="num">Rating</th>
                  <th className="num">Lives</th>
                  <th className="hide-narrow">Deployed</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.id} className={v.id === selected?.id ? "selected" : undefined}>
                    <td>
                      <Link
                        to="/@{$username}/$bot"
                        params={{ username: author.username, bot: bot.slug }}
                        search={{ ...pageSearch, v: v.n }}
                        aria-current={v.id === selected?.id ? "true" : undefined}
                      >
                        v{v.n}
                      </Link>
                    </td>
                    <td>
                      <span className={`status status-${v.status}`}>{STATUS[v.status]}</span>
                      {v.rejection && <div className="muted small">{v.rejection}</div>}
                    </td>
                    <td className="num">
                      {formatRating(v.rating, v.ratingCi)}
                      {v.ratedLives !== null && v.ratedLives < minLives && (
                        <div className="muted small">unranked</div>
                      )}
                    </td>
                    <td className="num">{v.lives}</td>
                    <td className="hide-narrow">{formatDate(v.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {paged && (
          <nav className="pager" aria-label="Version pages">
            {versionsPage > 1 ? (
              <Link
                to="/@{$username}/$bot"
                params={{ username: author.username, bot: bot.slug }}
                search={versionsPage === 2 ? {} : { page: versionsPage - 1 }}
              >
                ← Newer
              </Link>
            ) : (
              <span />
            )}
            <span className="muted">Page {versionsPage}</span>
            {hasOlder ? (
              <Link
                to="/@{$username}/$bot"
                params={{ username: author.username, bot: bot.slug }}
                search={{ page: versionsPage + 1 }}
              >
                Older →
              </Link>
            ) : (
              <span />
            )}
          </nav>
        )}
      </section>

      {selected && (
        <>
          <section className="panel">
            <h2 className="subtitle">Recent lives of v{selected.n}</h2>
            {selected.causes.length > 0 && <CausesCaption causes={selected.causes} />}
            {selected.causes.length > 0 && (
              <ul className="chips" aria-label="Death causes">
                {selected.causes.map((c) => (
                  <li key={c.cause} className="chip">
                    {DEATH_CAUSES[c.cause]} <span className="muted">{c.count}</span>
                  </li>
                ))}
              </ul>
            )}
            {selected.recentLives.length === 0 ? (
              <Empty>No finished lives yet.</Empty>
            ) : (
              <LivesTable lives={selected.recentLives} />
            )}
          </section>

          <section className="panel">
            <h2 className="subtitle">Sources of v{selected.n}</h2>
            <VersionSources versionId={selected.id} />
          </section>
        </>
      )}
    </>
  );
}

function LivesTable({ lives }: { lives: LifeRow[] }) {
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th className="num">Score</th>
            <th>Death</th>
            <th className="num hide-narrow">Length</th>
            <th className="num hide-narrow">Kills</th>
            <th className="num hide-narrow">Time</th>
            <th className="hide-narrow">Ended</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {lives.map((life) => (
            <tr key={life.id}>
              <td className="num">{life.score}</td>
              <td>
                {life.deathCause ? DEATH_CAUSES[life.deathCause] : "—"}
                {life.killer && (
                  <div className="muted small">
                    by <KillerName killer={life.killer} />
                  </div>
                )}
              </td>
              <td className="num hide-narrow">{life.lengthMax}</td>
              <td className="num hide-narrow">{life.kills}</td>
              <td className="num hide-narrow">{formatTicks(life.ticks)}</td>
              <td className="hide-narrow">{life.endedAt ? formatDateTime(life.endedAt) : "—"}</td>
              <td className="num">
                {life.hasReplay ? (
                  <Link to="/replay/$id" params={{ id: life.id }}>
                    Replay
                  </Link>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KillerName({ killer }: { killer: Killer }) {
  if (killer.kind === "house") return <>house bot {killer.name}</>;
  if (killer.kind === "unknown") return <>a deleted bot</>;
  return (
    <Link to="/@{$username}/$bot" params={{ username: killer.author, bot: killer.botSlug }}>
      {killer.botName} v{killer.version}
    </Link>
  );
}

/** Loaded after the page: an archive can be up to 1 MiB and isn't needed for the first paint. */
function VersionSources({ versionId }: { versionId: string }) {
  const [sources, setSources] = useState<Sources | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSources(undefined);
    setError(null);
    getVersionSources({ data: versionId })
      .then((s) => !cancelled && setSources(s))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [versionId]);
  if (error) return <p className="error">Couldn't load the sources: {error}</p>;
  if (sources === undefined) return <p className="muted">Loading sources…</p>;
  return <SourceFiles key={versionId} sources={sources} />;
}

function CausesCaption({ causes }: { causes: { count: number }[] }) {
  const n = causes.reduce((sum, c) => sum + c.count, 0);
  return (
    <p className="muted small">
      {n === 1 ? "How the latest life ended:" : `How the latest ${n} lives ended:`}
    </p>
  );
}
