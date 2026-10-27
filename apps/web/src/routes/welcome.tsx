import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { SignInTerms } from "../components/SignInTerms";
import { authClient } from "../lib/auth-client";

interface WelcomeSearch {
  next?: string;
}

/** Only same-site paths, so `?next=` can't bounce people elsewhere. */
function safeNext(next: string | undefined) {
  return next?.startsWith("/") && !next.startsWith("//") ? next : undefined;
}

/** GitHub logins are almost always valid usernames; drop whatever isn't. */
function suggest(login: string | null) {
  return (login ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 39);
}

export const Route = createFileRoute("/welcome")({
  validateSearch: (search: Record<string, unknown>): WelcomeSearch => {
    const next = safeNext(typeof search.next === "string" ? search.next : undefined);
    return next ? { next } : {};
  },
  beforeLoad: ({ context, search }) => {
    if (!context.viewer) throw redirect({ to: "/" });
    if (context.viewer.username) {
      throw redirect({
        href: search.next ?? `/@${context.viewer.username}`,
      });
    }
  },
  head: () => ({ meta: [{ title: "Choose a username · ZeroSnake Arena" }] }),
  component: Welcome,
});

function Welcome() {
  const { viewer } = Route.useRouteContext();
  const { next } = Route.useSearch();
  const router = useRouter();
  const [username, setUsername] = useState(() => suggest(viewer?.githubLogin ?? null));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const { error } = await authClient.username.claim({ username });
    setPending(false);
    if (error) {
      setError(error.message ?? "Couldn't save that username");
      return;
    }
    await router.invalidate();
    await router.navigate({ href: next ?? `/@${username.toLowerCase()}` });
  }

  return (
    <section className="panel">
      <h1 className="title">Welcome{viewer?.name ? `, ${viewer.name}` : ""}</h1>
      <p className="muted">
        Pick the username your bots will play under. It's in every URL, so it can't be changed
        later. Letters, digits, <code>-</code> and <code>_</code>.
      </p>
      <form className="form" onSubmit={submit}>
        <label className="input-prefix">
          <span className="accent">@</span>
          <input
            className="input"
            name="username"
            aria-label="Username"
            autoComplete="username"
            minLength={2}
            maxLength={39}
            pattern="[A-Za-z0-9](?:[A-Za-z0-9_\-]*[A-Za-z0-9])?"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="submit" className="button" disabled={pending || !username}>
            {pending ? "Saving…" : "Continue"}
          </button>
        </div>
        <SignInTerms action="continuing" />
      </form>
    </section>
  );
}
