import { createFileRoute, Link } from "@tanstack/react-router";
import { formatRating } from "../components/format";
import { PageError, PagePending } from "../components/PageState";
import { canonical, pageMeta } from "../lib/meta";
import { getLeaderboardPage } from "../server/pages";

interface LeaderboardSearch {
  page?: number;
}

export const Route = createFileRoute("/leaderboard")({
  validateSearch: (search: Record<string, unknown>): LeaderboardSearch => {
    const page = Number(search.page);
    return Number.isInteger(page) && page > 1 && page <= 1000 ? { page } : {};
  },
  loaderDeps: ({ search }) => ({ page: search.page ?? 1 }),
  loader: ({ deps }) => getLeaderboardPage({ data: { page: deps.page } }),
  head: () => ({
    meta: [
      ...pageMeta(
        "Leaderboard",
        "Every snake bot with 30+ lives in the arena, ranked by the low end of its rating.",
      ),
      ...canonical("/leaderboard").meta,
    ],
    links: canonical("/leaderboard").links,
  }),
  component: Leaderboard,
  pendingComponent: PagePending,
  errorComponent: PageError,
});

function Leaderboard() {
  const { entries, page, hasNext, minLives } = Route.useLoaderData();
  return (
    <section className="panel">
      <h1 className="title">Leaderboard</h1>
      <p className="muted">
        Ranked by the low end of each bot's rating, so a steady record beats a lucky streak. A
        version's rating is its mean score over its last 200 lives, ± a nominal 95% interval, and it
        appears here after {minLives} lives.{" "}
        <Link to="/docs/$slug" params={{ slug: "rating" }}>
          How rating works
        </Link>
      </p>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Bot</th>
              <th className="hide-narrow">Author</th>
              <th className="num">Rating</th>
              <th className="num hide-narrow" title="Rating minus its ± range: the sort key">
                Ranked by
              </th>
              <th className="num">Lives</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty">
                  {page === 1 ? (
                    <>
                      No bot has played {minLives} lives yet, so nobody is ranked. Be first: the
                      starter from <code>npx zerosnake init</code> already beats <code>easy</code>,
                      the bar for entering.
                      <br />
                      <Link to="/" hash="start">
                        Build your bot
                      </Link>
                    </>
                  ) : (
                    "No bots on this page."
                  )}
                </td>
              </tr>
            ) : (
              entries.map((e) => (
                <tr key={e.botId}>
                  <td className="num rank">{e.rank}</td>
                  <td>
                    <Link to="/@{$username}/$bot" params={{ username: e.author, bot: e.botSlug }}>
                      {e.botName}
                    </Link>{" "}
                    <span className="muted">v{e.version}</span>
                    <div className="show-narrow muted">
                      <Link to="/@{$username}" params={{ username: e.author }}>
                        @{e.author}
                      </Link>
                    </div>
                  </td>
                  <td className="hide-narrow">
                    <Link to="/@{$username}" params={{ username: e.author }}>
                      @{e.author}
                    </Link>
                  </td>
                  <td className="num">{formatRating(e.rating, e.ratingCi)}</td>
                  <td className="num hide-narrow">
                    {e.rating === null ? "—" : (e.rating - (e.ratingCi ?? 0)).toFixed(1)}
                  </td>
                  <td className="num">{e.lives}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {(page > 1 || hasNext) && (
        <nav className="pager" aria-label="Pages">
          {page > 1 ? (
            <Link to="/leaderboard" search={page === 2 ? {} : { page: page - 1 }}>
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="muted">Page {page}</span>
          {hasNext ? (
            <Link to="/leaderboard" search={{ page: page + 1 }}>
              Next →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </section>
  );
}
