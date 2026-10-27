import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { formatDateTime } from "../components/format";
import { Empty, PageError, PagePending } from "../components/PageState";
import {
  banBot,
  banUser,
  banVersion,
  getAdminPage,
  setArenaPaused,
  setDeploysPaused,
  unbanBot,
  unbanUser,
} from "../server/admin";
import type { ModerationPage, ModerationResult } from "../server/moderation";

// Admins only (ADMIN_USER_IDS / ADMIN_GITHUB_IDS); everyone else gets a short refusal.
export const Route = createFileRoute("/admin")({
  beforeLoad: ({ context }) => {
    if (!context.viewer) throw redirect({ to: "/" });
  },
  loader: () => getAdminPage(),
  head: () => ({
    meta: [{ title: "Admin · ZeroSnake Arena" }, { name: "robots", content: "noindex" }],
  }),
  component: AdminPage,
  pendingComponent: PagePending,
  errorComponent: PageError,
});

type Notice = { kind: "ok" | "error"; text: string } | null;

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  async function act<T>(call: () => Promise<ModerationResult<T>>, done: string) {
    setBusy(true);
    setNotice(null);
    try {
      const result = await call();
      setNotice(result.ok ? { kind: "ok", text: done } : { kind: "error", text: result.message });
      if (result.ok) await router.invalidate();
      return result.ok;
    } catch {
      setNotice({ kind: "error", text: "Something went wrong. Try again." });
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { act, busy, notice };
}

type Action = ReturnType<typeof useAction>;

function AdminPage() {
  const result = Route.useLoaderData();
  const action = useAction();
  if (!result.ok) {
    return (
      <section className="panel">
        <h1 className="title">Admin</h1>
        <p className="muted">{result.message}</p>
      </section>
    );
  }
  const page = result.value;
  return (
    <>
      <section className="panel">
        <h1 className="title">Admin</h1>
        {action.notice && (
          <p
            className={action.notice.kind === "error" ? "error" : "accent"}
            role={action.notice.kind === "error" ? "alert" : "status"}
          >
            {action.notice.text}
          </p>
        )}
        <KillSwitch page={page} action={action} />
      </section>
      <section className="panel">
        <h2 className="subtitle">Ban</h2>
        <p className="muted small">
          A banned version is rejected for good. A banned bot or user stops playing at once (the
          active version is archived) and can't deploy until the ban is lifted.
        </p>
        <BanForm
          label="User"
          placeholder="@username or user id"
          action={action}
          ban={(ref, reason) => banUser({ data: { user: ref, reason } })}
          unban={(ref, reason) => unbanUser({ data: { user: ref, reason } })}
        />
        <BanForm
          label="Bot"
          placeholder="@user/bot, its URL, or bot id"
          action={action}
          ban={(ref, reason) => banBot({ data: { bot: ref, reason } })}
          unban={(ref, reason) => unbanBot({ data: { bot: ref, reason } })}
        />
        <BanForm
          label="Version"
          placeholder="@user/bot/3, …/@user/bot?v=3, or version id"
          action={action}
          ban={(ref, reason) => banVersion({ data: { version: ref, reason } })}
        />
      </section>
      <Banned page={page} />
      <Log page={page} />
    </>
  );
}

function KillSwitch({ page, action }: { page: ModerationPage; action: Action }) {
  const [reason, setReason] = useState("");
  const { control } = page;

  async function flip(which: "arena" | "deploys") {
    const paused = which === "arena" ? !control.paused : !control.deploysPaused;
    const call = which === "arena" ? setArenaPaused : setDeploysPaused;
    const done = `${which === "arena" ? "Arena" : "Deploys"} ${paused ? "paused" : "resumed"}.`;
    if (await action.act(() => call({ data: { paused, reason } }), done)) setReason("");
  }

  return (
    <>
      <dl className="facts">
        <div>
          <dt>Arena</dt>
          <dd className={control.paused ? "red" : undefined}>
            {control.paused ? "paused" : "running"}
          </dd>
        </div>
        <div>
          <dt>Deploys</dt>
          <dd className={control.deploysPaused ? "red" : undefined}>
            {control.deploysPaused ? "paused" : "open"}
          </dd>
        </div>
        <div>
          <dt>Last change</dt>
          <dd>
            {control.updatedBy && control.updatedAt
              ? `${formatDateTime(control.updatedAt)} by ${control.updatedBy}`
              : "never"}
          </dd>
        </div>
      </dl>
      {control.reason && <p className="muted small">Reason: {control.reason}</p>}
      <form className="inline-form" onSubmit={(e) => e.preventDefault()}>
        <label className="sr-only" htmlFor="control-reason">
          Reason
        </label>
        <input
          id="control-reason"
          className="input"
          placeholder="Reason (required)"
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
        <button
          type="button"
          className="button small"
          disabled={action.busy || reason.trim().length < 3}
          onClick={() => flip("arena")}
        >
          {control.paused ? "Resume arena" : "Pause arena"}
        </button>
        <button
          type="button"
          className="button ghost small"
          disabled={action.busy || reason.trim().length < 3}
          onClick={() => flip("deploys")}
        >
          {control.deploysPaused ? "Open deploys" : "Pause deploys"}
        </button>
      </form>
    </>
  );
}

function BanForm({
  label,
  placeholder,
  action,
  ban,
  unban,
}: {
  label: string;
  placeholder: string;
  action: Action;
  ban: (ref: string, reason: string) => Promise<ModerationResult<unknown>>;
  unban?: (ref: string, reason: string) => Promise<ModerationResult<unknown>>;
}) {
  const [ref, setRef] = useState("");
  const [reason, setReason] = useState("");
  const id = `ban-${label.toLowerCase()}`;
  const ready = ref.trim() !== "" && reason.trim().length >= 3 && !action.busy;

  async function run(event: FormEvent | null, lift: boolean) {
    event?.preventDefault();
    const call = lift ? unban : ban;
    if (!call) return;
    const done = `${label} ${ref.trim()} ${lift ? "unbanned" : "banned"}.`;
    if (await action.act(() => call(ref, reason), done)) {
      setRef("");
      setReason("");
    }
  }

  return (
    <form className="inline-form" onSubmit={(e) => run(e, false)}>
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        placeholder={placeholder}
        value={ref}
        maxLength={500}
        onChange={(e) => setRef(e.target.value)}
      />
      <label className="sr-only" htmlFor={`${id}-reason`}>
        Reason
      </label>
      <input
        id={`${id}-reason`}
        className="input"
        placeholder="Reason (shown to the author)"
        value={reason}
        maxLength={500}
        onChange={(e) => setReason(e.target.value)}
      />
      <button type="submit" className="button small" disabled={!ready}>
        Ban {label.toLowerCase()}
      </button>
      {unban && (
        <button
          type="button"
          className="button ghost small"
          disabled={!ready}
          onClick={() => run(null, true)}
        >
          Unban
        </button>
      )}
    </form>
  );
}

function Banned({ page }: { page: ModerationPage }) {
  return (
    <section className="panel">
      <h2 className="subtitle">Banned</h2>
      {page.bannedUsers.length === 0 && page.bannedBots.length === 0 ? (
        <Empty>Nobody is banned.</Empty>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Who</th>
                <th>Since</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {page.bannedUsers.map((u) => (
                <tr key={u.id}>
                  <td>@{u.username ?? u.id}</td>
                  <td>{formatDateTime(u.bannedAt)}</td>
                  <td>{u.reason}</td>
                </tr>
              ))}
              {page.bannedBots.map((b) => (
                <tr key={b.id}>
                  <td>
                    @{b.owner ?? "?"}/{b.slug}
                  </td>
                  <td>{formatDateTime(b.bannedAt)}</td>
                  <td>{b.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const ACTION_LABELS: Record<ModerationPage["recent"][number]["action"], string> = {
  pause_arena: "paused the arena",
  resume_arena: "resumed the arena",
  pause_deploys: "paused deploys",
  resume_deploys: "opened deploys",
  ban_user: "banned",
  unban_user: "unbanned",
  ban_bot: "banned",
  unban_bot: "unbanned",
  ban_version: "banned",
};

function Log({ page }: { page: ModerationPage }) {
  return (
    <section className="panel">
      <h2 className="subtitle">Log</h2>
      {page.recent.length === 0 ? (
        <Empty>No admin actions yet.</Empty>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {page.recent.map((entry) => (
                <tr key={entry.id}>
                  <td>{formatDateTime(entry.createdAt)}</td>
                  <td>
                    {entry.admin} {ACTION_LABELS[entry.action]}
                    {entry.target ? ` ${entry.target}` : ""}
                  </td>
                  <td>{entry.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
