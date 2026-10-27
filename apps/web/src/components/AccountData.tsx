import { Link } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";

/**
 * "Download my data" and "Delete my account" (src/server/account.ts), on `/settings` and, for
 * someone who signed in but hasn't chosen a username yet, on `/welcome`. The deletion is
 * confirmed by typing the username, or `confirmWord` before there is one (the server's
 * `deleteConfirmation`).
 */
export function AccountData({
  username,
  title = "Your data",
  deleteLabel = "Delete my account",
}: {
  username: string | null;
  title?: string;
  deleteLabel?: string;
}) {
  const confirmWord = username ?? "delete";
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const matches = typed.trim().toLowerCase() === confirmWord.toLowerCase();

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
      <h2 className="subtitle">{title}</h2>
      <p className="muted">
        A JSON file with everything we keep about you: your profile
        {username ? ", bots, versions, ratings, lives" : ""} and sessions
        {username ? ", with links to download each version's bundle and sources" : ""}. See the{" "}
        <Link to="/privacy">privacy policy</Link>.
      </p>
      <div className="actions">
        <a className="button ghost" href="/api/account/export" download>
          Download my data
        </a>
        {confirming ? null : (
          <button type="button" className="button danger" onClick={() => setConfirming(true)}>
            {deleteLabel}
          </button>
        )}
      </div>
      {confirming ? (
        <form className="danger-zone" onSubmit={deleteAccount}>
          <p>
            {username
              ? "This deletes your account for good. Your bots stop playing at once and leave the leaderboard; their code, versions, ratings, lives and logs are erased, usually within a few hours. Lives of other players your bots took part in stay, without your name. There is no undo: download your data first if you want a copy."
              : "This deletes your account and everything GitHub told us about you. There is no undo."}
          </p>
          <div className="form">
            <label htmlFor={inputId}>
              Type {username ? "your username" : "the word"} <strong>{confirmWord}</strong> to
              confirm
            </label>
            <input
              id={inputId}
              className="input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="actions">
            <button type="submit" className="button danger" disabled={!matches || busy}>
              {busy ? "Deleting…" : deleteLabel}
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
