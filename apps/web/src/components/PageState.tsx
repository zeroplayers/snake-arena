import { type ErrorComponentProps, Link, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";

/** Route `pendingComponent`: shown while a loader takes longer than the router's pending delay. */
export function PagePending() {
  return (
    <section className="panel" aria-busy="true">
      <div className="skeleton skeleton-title" />
      <div className="skeleton" />
      <div className="skeleton" />
      <div className="skeleton short" />
    </section>
  );
}

/** Route `errorComponent`: a loader or render failed. */
export function PageError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <section className="panel" role="alert">
      <h1 className="title red">Something broke</h1>
      <p className="muted">{error instanceof Error ? error.message : "Unknown error"}</p>
      <div className="actions">
        <button
          type="button"
          className="button"
          onClick={() => {
            reset();
            void router.invalidate();
          }}
        >
          Try again
        </button>
        <Link to="/" className="button ghost">
          Back to the arena
        </Link>
      </div>
    </section>
  );
}

/** A "nothing here yet" block inside a panel. */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty-block">{children}</p>;
}
