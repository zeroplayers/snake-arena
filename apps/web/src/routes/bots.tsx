import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { type FormEvent, Fragment, useCallback, useEffect, useState } from "react";
import { formatDate, formatDateTime, formatRating } from "../components/format";
import { Empty, PageError, PagePending } from "../components/PageState";
import type { AdminResult, ManagedBot, ManagedVersion, ManagePage } from "../server/bot-admin";
import {
  activateVersion,
  archiveBot,
  archiveVersion,
  createBot,
  getManagePage,
  getOlderVersions,
  renameBot,
  restoreBot,
} from "../server/manage";

export const Route = createFileRoute("/bots")({
  beforeLoad: ({ context }) => {
    if (!context.viewer) throw redirect({ to: "/" });
  },
  loader: async () => {
    const result = await getManagePage();
    if (!result.ok) throw redirect({ to: "/" });
    return result.value;
  },
  head: () => ({
    meta: [{ title: "Your bots · ZeroSnake Arena" }, { name: "robots", content: "noindex" }],
  }),
  component: BotsPage,
  pendingComponent: PagePending,
  errorComponent: PageError,
});

const STATUS: Record<ManagedVersion["status"], string> = {
  ready: "active",
  validating: "checking",
  rejected: "rejected",
  archived: "archived",
};

type Notice = { kind: "ok" | "error"; text: string } | null;

/** Runs a server function, then reloads the page data; shows its message either way. */
function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  async function act<T>(key: string, call: () => Promise<AdminResult<T>>, done?: string) {
    setBusy(key);
    setNotice(null);
    try {
      const result = await call();
      if (result.ok) {
        if (done) setNotice({ kind: "ok", text: done });
        await router.invalidate();
      } else {
        setNotice({ kind: "error", text: result.message });
      }
      return result.ok;
    } catch {
      setNotice({ kind: "error", text: "Something went wrong. Try again." });
      return false;
    } finally {
      setBusy(null);
    }
  }

  const report = useCallback((text: string) => setNotice({ kind: "error", text }), []);

  return { act, busy, notice, report };
}

type Action = ReturnType<typeof useAction>;

function BotsPage() {
  const page = Route.useLoaderData();
  const action = useAction();
  const active = page.bots.filter((b) => !b.archivedAt);
  const archived = page.bots.filter((b) => b.archivedAt);

  return (
    <>
      <section className="panel">
        <h1 className="title">Your bots</h1>
        {page.banned && (
          <p className="error" role="alert">
            Your account is suspended
            {page.banned.reason ? `: ${page.banned.reason}` : ""}. Your bots don't play, and nothing
            can be deployed or changed.
          </p>
        )}
        <Quotas page={page} />
        {action.notice && (
          <p
            className={action.notice.kind === "error" ? "error" : "accent"}
            role={action.notice.kind === "error" ? "alert" : "status"}
          >
            {action.notice.text}
          </p>
        )}
        <NewBot page={page} action={action} />
      </section>

      {active.length === 0 ? (
        <section className="panel">
          <Empty>
            No active bots. Create one above, or run <code>npx zerosnake deploy</code> in a bot
            project.
          </Empty>
        </section>
      ) : (
        active.map((bot) => <BotPanel key={bot.id} bot={bot} page={page} action={action} />)
      )}

      <RejectedReports page={page} />

      {archived.length > 0 && (
        <section className="panel">
          <h2 className="subtitle">Archived bots</h2>
          <p className="muted small">
            Archived bots don't play and don't count against your {page.limits.botsPerAuthor} bots.
            Their pages and slugs stay. A restored bot comes back without an active version.
          </p>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Bot</th>
                  <th className="hide-narrow">Versions</th>
                  <th>Archived</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {archived.map((bot) => (
                  <tr key={bot.id}>
                    <td>
                      <BotLink page={page} bot={bot} />
                    </td>
                    <td className="hide-narrow">{bot.versionCount}</td>
                    <td>{bot.archivedAt && formatDate(bot.archivedAt)}</td>
                    <td className="num">
                      <button
                        type="button"
                        className="button ghost small"
                        disabled={
                          action.busy !== null || page.activeBots >= page.limits.botsPerAuthor
                        }
                        title={
                          page.activeBots >= page.limits.botsPerAuthor
                            ? `Archive a bot first: you have ${page.limits.botsPerAuthor} active.`
                            : undefined
                        }
                        onClick={() =>
                          action.act(
                            `restore:${bot.id}`,
                            () => restoreBot({ data: { botId: bot.id } }),
                            `Restored ${bot.name}. Pick a version to make it play again.`,
                          )
                        }
                      >
                        Restore
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

function Quotas({ page }: { page: ManagePage }) {
  const { quota, limits } = page;
  return (
    <dl className="facts">
      <div>
        <dt>Active bots</dt>
        <dd>
          {page.activeBots} / {limits.botsPerAuthor}
        </dd>
      </div>
      <div>
        <dt>Deploys today</dt>
        <dd className={quota.deploysToday >= quota.deploysPerDay ? "red" : undefined}>
          {quota.deploysToday} / {quota.deploysPerDay}
        </dd>
      </div>
      <div>
        <dt>Resets</dt>
        <dd>{formatDateTime(quota.resetsAt)}</dd>
      </div>
      <p className="muted small quota-note">
        Deploys and rollbacks share the daily quota. Each bot plays up to {limits.livesPerBotPerDay}{" "}
        lives a day.
      </p>
    </dl>
  );
}

function NewBot({ page, action }: { page: ManagePage; action: Action }) {
  const [name, setName] = useState("");
  const full = page.activeBots >= page.limits.botsPerAuthor;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const created = await action.act(
      "create",
      () => createBot({ data: { name } }),
      `Created ${name.trim()}. Deploy to it with npx zerosnake deploy.`,
    );
    if (created) setName("");
  }

  return (
    <form className="inline-form" onSubmit={submit}>
      <label className="sr-only" htmlFor="new-bot-name">
        New bot name
      </label>
      <input
        id="new-bot-name"
        className="input"
        placeholder={full ? "Archive a bot to free a slot" : "New bot name"}
        value={name}
        maxLength={40}
        disabled={full}
        onChange={(e) => setName(e.target.value)}
      />
      <button
        type="submit"
        className="button small"
        disabled={full || name.trim() === "" || action.busy !== null}
      >
        Create bot
      </button>
    </form>
  );
}

function BotLink({ page, bot }: { page: ManagePage; bot: ManagedBot }) {
  return page.username ? (
    <Link to="/@{$username}/$bot" params={{ username: page.username, bot: bot.slug }}>
      {bot.name}
    </Link>
  ) : (
    <>{bot.name}</>
  );
}

function BotPanel({ bot, page, action }: { bot: ManagedBot; page: ManagePage; action: Action }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(bot.name);
  const left = page.quota.deploysPerDay - page.quota.deploysToday;
  const current = bot.activeVersion;
  const older = useOlderVersions(bot, page.versionsPerPage, action);
  const listed = [...bot.versions, ...older.versions];
  // The active version stays in reach however many versions came after it.
  const rows = current && !listed.some((v) => v.id === current.id) ? [current, ...listed] : listed;

  async function rename(event: FormEvent) {
    event.preventDefault();
    const ok = await action.act("rename", () => renameBot({ data: { botId: bot.id, name } }));
    if (ok) setRenaming(false);
  }

  function rollBack(v: ManagedVersion) {
    const replaces = current ? ` It replaces v${current.n} in the arena,` : " It";
    const message =
      `Make v${v.n} active?${replaces} starts v${v.n}'s rating over and uses 1 of ` +
      `today's ${left} remaining deploys.`;
    if (!window.confirm(message)) return;
    void action.act(
      `activate:${v.id}`,
      () => activateVersion({ data: { versionId: v.id } }),
      `v${v.n} of ${bot.name} is active now.`,
    );
  }

  function stop(v: ManagedVersion) {
    if (!window.confirm(`Archive v${v.n}? ${bot.name} stops playing until a version is active.`)) {
      return;
    }
    void action.act(
      `deactivate:${v.id}`,
      () => archiveVersion({ data: { versionId: v.id } }),
      `${bot.name} has no active version now.`,
    );
  }

  /** Archive for the active version, Make active for earlier ones. */
  function versionAction(v: ManagedVersion) {
    if (v.status === "ready") {
      return (
        <button
          type="button"
          className="button ghost small"
          disabled={action.busy !== null}
          onClick={() => stop(v)}
        >
          Archive
        </button>
      );
    }
    if (!v.canActivate) return null;
    return (
      <button
        type="button"
        className="button small"
        disabled={action.busy !== null || left <= 0}
        title={left <= 0 ? "No deploys left today." : undefined}
        onClick={() => rollBack(v)}
      >
        Make active
      </button>
    );
  }

  function archive() {
    if (!window.confirm(`Archive ${bot.name}? It stops playing and frees a bot slot.`)) return;
    void action.act(
      `archive:${bot.id}`,
      () => archiveBot({ data: { botId: bot.id } }),
      `Archived ${bot.name}.`,
    );
  }

  return (
    <section className="panel" aria-labelledby={`bot-${bot.id}`}>
      <div className="bot-head">
        {renaming ? (
          <form className="inline-form" onSubmit={rename}>
            <label className="sr-only" htmlFor={`rename-${bot.id}`}>
              Bot name
            </label>
            <input
              id={`rename-${bot.id}`}
              className="input"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
            />
            <button type="submit" className="button small" disabled={action.busy !== null}>
              Save
            </button>
            <button
              type="button"
              className="button ghost small"
              onClick={() => {
                setRenaming(false);
                setName(bot.name);
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <h2 className="subtitle" id={`bot-${bot.id}`}>
            <BotLink page={page} bot={bot} /> <span className="muted small">/{bot.slug}</span>
          </h2>
        )}
        <div className="bot-actions">
          {!renaming && (
            <button
              type="button"
              className="button ghost small"
              onClick={() => setRenaming(true)}
              title="The name changes; the slug and links stay."
            >
              Rename
            </button>
          )}
          <button
            type="button"
            className="button ghost small"
            disabled={action.busy !== null}
            onClick={archive}
          >
            Archive bot
          </button>
        </div>
      </div>
      {bot.banned && (
        <p className="error">
          Banned{bot.banned.reason ? `: ${bot.banned.reason}` : ""}. It doesn't play and can't be
          deployed to.
        </p>
      )}
      <p className="muted">
        {current ? (
          <>
            Playing <span className="accent">v{current.n}</span>
          </>
        ) : (
          "Not playing: no active version"
        )}{" "}
        · Lives today{" "}
        <span className={bot.livesToday >= page.limits.livesPerBotPerDay ? "red" : undefined}>
          {bot.livesToday} / {page.limits.livesPerBotPerDay}
        </span>
      </p>

      {rows.length === 0 ? (
        <Empty>
          No versions yet. <code>npx zerosnake deploy</code> uploads the first one.
        </Empty>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Version</th>
                <th>Status</th>
                <th className="num" title="Rating: points per minute alive">
                  Pts/min
                </th>
                <th className="num hide-narrow">Lives</th>
                <th className="hide-narrow">Deployed</th>
                <th className="hide-narrow" />
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => {
                const details = v.message !== null || v.problems.length > 0;
                const rowClass = [v.status === "ready" && "selected", details && "has-details"]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <Fragment key={v.id}>
                    <tr className={rowClass || undefined}>
                      <td>v{v.n}</td>
                      <td>
                        <span className={`status status-${v.status}`}>{STATUS[v.status]}</span>
                        <div className="show-narrow">{versionAction(v)}</div>
                      </td>
                      <td className="num">
                        {v.rating ? formatRating(v.rating.mean, v.rating.ci) : "—"}
                      </td>
                      <td className="num hide-narrow">{v.lives}</td>
                      <td className="hide-narrow">{formatDate(v.createdAt)}</td>
                      <td className="num hide-narrow">{versionAction(v)}</td>
                    </tr>
                    {details && (
                      <tr className={v.status === "ready" ? "details selected" : "details"}>
                        <td colSpan={6} className="muted small">
                          {v.message && <div>“{v.message}”</div>}
                          {v.problems.map((line) => (
                            <div key={line} className="pink">
                              {line}
                            </div>
                          ))}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {older.hasMore && (
        <p className="muted small">
          The latest {listed.length} of {bot.versionCount} versions.{" "}
          <button
            type="button"
            className="button ghost small"
            disabled={older.loading}
            onClick={older.more}
          >
            Show older
          </button>
        </p>
      )}
    </section>
  );
}

/**
 * Older versions than the first page, loaded on demand, `perPage` at a time. Reloaded
 * (as many as were shown) whenever the page data is, so statuses stay current after an action.
 */
function useOlderVersions(bot: ManagedBot, perPage: number, action: Action) {
  const [wanted, setWanted] = useState(0);
  const [versions, setVersions] = useState<ManagedVersion[]>([]);
  const [hasMore, setHasMore] = useState(bot.versionCount > bot.versions.length);
  const [loading, setLoading] = useState(false);
  const before = bot.versions.at(-1)?.n;

  useEffect(() => {
    if (wanted === 0 || before === undefined) {
      setVersions([]);
      setHasMore(bot.versionCount > bot.versions.length);
      return;
    }
    let live = true;
    setLoading(true);
    getOlderVersions({ data: { botId: bot.id, before, limit: wanted } })
      .then((result) => {
        if (!live) return;
        if (result.ok) {
          setVersions(result.value.versions);
          setHasMore(result.value.hasMore);
        } else {
          action.report(result.message);
        }
      })
      .catch(() => live && action.report("Couldn't load older versions. Try again."))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [bot, before, wanted, action.report]);

  return {
    versions,
    hasMore,
    loading,
    more: () => setWanted((n) => n + perPage),
  };
}

function RejectedReports({ page }: { page: ManagePage }) {
  if (page.rejected.length === 0) return null;
  return (
    <section className="panel">
      <h2 className="subtitle">Recent check reports</h2>
      <p className="muted small">Rejected versions, newest first.</p>
      <ul className="reports">
        {page.rejected.map((r) => (
          <li key={r.versionId}>
            <div>
              <span className="accent">{r.botName}</span> v{r.n}{" "}
              <span className="muted small">{formatDateTime(r.createdAt)}</span>
            </div>
            {r.problems.length === 0 ? (
              <div className="muted small">No details.</div>
            ) : (
              r.problems.map((line) => <div key={line}>{line}</div>)
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
