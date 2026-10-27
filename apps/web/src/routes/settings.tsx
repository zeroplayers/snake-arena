import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { authClient } from "../lib/auth-client";
import { getCliTokens } from "../server/functions";

export const Route = createFileRoute("/settings")({
  beforeLoad: ({ context }) => {
    if (!context.viewer) throw redirect({ to: "/" });
  },
  loader: () => getCliTokens(),
  head: () => ({ meta: [{ title: "Settings · ZeroSnake Arena" }] }),
  component: Settings,
});

// Fixed zone so the server render and hydration agree.
const dateFormat = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
  hourCycle: "h23",
});

function formatDate(value: Date | string) {
  const date = new Date(value);
  return <time dateTime={date.toISOString()}>{dateFormat.format(date)} UTC</time>;
}

function Settings() {
  const { viewer } = Route.useRouteContext();
  const tokens = Route.useLoaderData();
  const router = useRouter();
  const [revoking, setRevoking] = useState<string | null>(null);

  async function revoke(id: string) {
    setRevoking(id);
    await authClient.cli.tokens.revoke({ id });
    setRevoking(null);
    await router.invalidate();
  }

  async function signOut() {
    await authClient.signOut();
    await router.invalidate();
    await router.navigate({ to: "/" });
  }

  return (
    <>
      <section className="panel">
        <h1 className="title">Settings</h1>
        <p className="muted">
          Signed in as <span className="accent">@{viewer?.username}</span> with GitHub
          {viewer?.githubLogin ? ` (${viewer.githubLogin})` : ""}.
        </p>
        <button type="button" className="button ghost" onClick={signOut}>
          Sign out
        </button>
      </section>

      <section className="panel">
        <h2 className="subtitle">CLI tokens</h2>
        <p className="muted">
          Each <code>zerosnake login</code> creates one. Revoke any you don't recognise.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Client</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tokens.length === 0 ? (
              <tr>
                <td colSpan={5} className="empty">
                  No CLI tokens. Run <code>npx zerosnake login</code> to create one.
                </td>
              </tr>
            ) : (
              tokens.map((token) => (
                <tr key={token.id}>
                  <td>
                    {token.userAgent || "unknown"}
                    {token.ipAddress ? <span className="muted"> · {token.ipAddress}</span> : null}
                  </td>
                  <td>{formatDate(token.createdAt)}</td>
                  <td>{formatDate(token.lastUsedAt)}</td>
                  <td>{formatDate(token.expiresAt)}</td>
                  <td className="num">
                    <button
                      type="button"
                      className="button ghost small"
                      disabled={revoking === token.id}
                      onClick={() => revoke(token.id)}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <YourData username={viewer?.username ?? ""} />
    </>
  );
}

/** "Download my data" and "Delete my account" (src/server/account.ts). */
function YourData({ username }: { username: string }) {
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim().toLowerCase() === username.toLowerCase();

  async function deleteAccount(event: FormEvent) {
    event.preventDefault();
    if (!matches) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: typed }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `The deletion failed (HTTP ${response.status}).`);
      }
      // Signed out everywhere: a full load drops everything the client still holds.
      window.location.assign("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2 className="subtitle">Your data</h2>
      <p className="muted">
        A JSON file with everything we keep about you: your profile, bots, versions, ratings, lives
        and sessions, with links to download each version's bundle and sources. See the{" "}
        <Link to="/privacy">privacy policy</Link>.
      </p>
      <div className="actions">
        <a className="button ghost" href="/api/account/export" download>
          Download my data
        </a>
        {confirming ? null : (
          <button type="button" className="button danger" onClick={() => setConfirming(true)}>
            Delete my account
          </button>
        )}
      </div>
      {confirming ? (
        <form className="danger-zone" onSubmit={deleteAccount}>
          <p>
            This deletes your account for good. Your bots stop playing at once and leave the
            leaderboard; within the hour their code, versions, ratings, lives and logs are erased.
            Lives of other players your bots took part in stay, without your name. There is no undo:
            download your data first if you want a copy.
          </p>
          <label className="form">
            <span>
              Type your username <strong>{username}</strong> to confirm
            </span>
            <input
              className="input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-label="Your username"
            />
          </label>
          {error ? <p className="error">{error}</p> : null}
          <div className="actions">
            <button type="submit" className="button danger" disabled={!matches || busy}>
              {busy ? "Deleting…" : "Delete my account"}
            </button>
            <button
              type="button"
              className="button ghost"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                setTyped("");
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
