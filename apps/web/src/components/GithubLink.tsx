import { REPO } from "../site";

/** A link to the repository, or a "soon" placeholder while it's private. */
export function GithubLink({ className }: { className?: string }) {
  if (REPO.public) {
    return (
      <a href={REPO.url} className={className} rel="noreferrer">
        GitHub
      </a>
    );
  }
  return (
    <span className={["soon", className].filter(Boolean).join(" ")} title="Opens at launch">
      GitHub <span className="soon-tag">soon</span>
    </span>
  );
}
