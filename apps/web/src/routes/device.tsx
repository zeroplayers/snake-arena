import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { SignInTerms } from "../components/SignInTerms";
import { authClient, signInWithGithub } from "../lib/auth-client";

interface DeviceSearch {
  user_code?: string;
}

/** Device endpoints answer with OAuth-style `error_description`, our guards with `message`. */
function errorText(error: object, fallback: string) {
  if ("error_description" in error && typeof error.error_description === "string") {
    return error.error_description;
  }
  if ("message" in error && typeof error.message === "string") return error.message;
  return fallback;
}

type Step =
  | { kind: "enter" }
  | { kind: "confirm"; userCode: string }
  | { kind: "done"; approved: boolean };

/** Where `zerosnake login` sends people: confirm the code shown in the terminal. */
export const Route = createFileRoute("/device")({
  validateSearch: (search: Record<string, unknown>): DeviceSearch =>
    typeof search.user_code === "string" ? { user_code: search.user_code } : {},
  head: () => ({ meta: [{ title: "Sign in the CLI · ZeroSnake Arena" }] }),
  component: Device,
});

function Device() {
  const { viewer } = Route.useRouteContext();
  const { user_code } = Route.useSearch();

  if (!viewer) {
    return (
      <section className="panel">
        <h1 className="title">Sign in the CLI</h1>
        <p className="muted">
          Sign in on the site first, then confirm the code from your terminal.
        </p>
        <button type="button" className="button" onClick={() => signInWithGithub()}>
          Sign in with GitHub
        </button>
        <SignInTerms />
      </section>
    );
  }
  return <Confirm initialCode={user_code ?? ""} />;
}

function Confirm({ initialCode }: { initialCode: string }) {
  const [code, setCode] = useState(initialCode);
  const [step, setStep] = useState<Step>({ kind: "enter" });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function lookUp(userCode: string) {
    setPending(true);
    setError(null);
    // Also ties the code to this account; approve/deny only work after this.
    const { data, error } = await authClient.device({ query: { user_code: userCode } });
    setPending(false);
    if (error || !data) {
      setError(errorText(error ?? {}, "Unknown or expired code"));
      return;
    }
    if (data.status !== "pending") {
      setError("This code was already used. Run `zerosnake login` again.");
      return;
    }
    setStep({ kind: "confirm", userCode: data.user_code });
  }

  // `verification_uri_complete` links straight here with the code filled in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once for the code in the URL
  useEffect(() => {
    if (initialCode) void lookUp(initialCode);
  }, []);

  async function decide(approve: boolean) {
    if (step.kind !== "confirm") return;
    setPending(true);
    setError(null);
    const body = { userCode: step.userCode };
    const { error } = approve
      ? await authClient.device.approve(body)
      : await authClient.device.deny(body);
    setPending(false);
    if (error) {
      setError(errorText(error, "Something went wrong"));
      return;
    }
    setStep({ kind: "done", approved: approve });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void lookUp(code.trim());
  }

  return (
    <section className="panel">
      <h1 className="title">Sign in the CLI</h1>
      {step.kind === "enter" && (
        <form className="form" onSubmit={submit}>
          <p className="muted">
            Enter the code <code>zerosnake login</code> printed in your terminal.
          </p>
          <input
            className="input"
            name="user_code"
            aria-label="Code"
            autoComplete="off"
            required
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          {error && <p className="error">{error}</p>}
          <div className="actions">
            <button type="submit" className="button" disabled={pending || !code}>
              Continue
            </button>
          </div>
        </form>
      )}
      {step.kind === "confirm" && (
        <div className="form">
          <p className="muted">Check that your terminal shows this code:</p>
          <p className="user-code">{step.userCode}</p>
          <p className="muted">
            Approving lets the CLI deploy bots and read logs as you. You can revoke it in Settings.
          </p>
          {error && <p className="error">{error}</p>}
          <div className="actions">
            <button
              type="button"
              className="button"
              disabled={pending}
              onClick={() => decide(true)}
            >
              Approve
            </button>
            <button
              type="button"
              className="button ghost"
              disabled={pending}
              onClick={() => decide(false)}
            >
              Deny
            </button>
          </div>
        </div>
      )}
      {step.kind === "done" && (
        <p className="muted">
          {step.approved
            ? "Done. You can go back to your terminal."
            : "Denied. The CLI was not signed in."}
        </p>
      )}
    </section>
  );
}
