import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { LEGAL, LEGAL_UPDATED } from "../legal";

/** Frame of `/terms`, `/acceptable-use` and `/privacy`: the docs' typography, a date, the siblings. */
export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className="doc panel legal">
      <h1>{title}</h1>
      <p className="muted">Last updated {LEGAL_UPDATED}.</p>
      {children}
      <nav className="legal-nav" aria-label="Legal">
        <Link to="/terms">Terms of Service</Link>
        <Link to="/acceptable-use">Acceptable Use</Link>
        <Link to="/privacy">Privacy Policy</Link>
      </nav>
    </article>
  );
}

/** The contact address, as a link. */
export function ContactEmail() {
  return <a href={`mailto:${LEGAL.email}`}>{LEGAL.email}</a>;
}
