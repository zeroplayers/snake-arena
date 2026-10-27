import { Link } from "@tanstack/react-router";
import { MINIMUM_AGE } from "../legal";

/** The line next to sign-in steps: what signing up agrees to. */
export function SignInTerms({ action = "signing in" }: { action?: string }) {
  return (
    <p className="muted small">
      By {action} you confirm you are at least {MINIMUM_AGE} and accept the{" "}
      <Link to="/terms">Terms of Service</Link> and{" "}
      <Link to="/acceptable-use">Acceptable Use Policy</Link>. How we handle your data:{" "}
      <Link to="/privacy">Privacy Policy</Link>.
    </p>
  );
}
