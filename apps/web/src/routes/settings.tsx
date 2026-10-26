import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
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
    </>
  );
}
