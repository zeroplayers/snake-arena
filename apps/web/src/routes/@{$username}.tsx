import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/@{$username}")({
  head: ({ params }) => ({ meta: [{ title: `@${params.username} · ZeroSnake Arena` }] }),
  component: ProfilePage,
});

function ProfilePage() {
  const { username } = Route.useParams();
  return (
    <section className="panel">
      <h1 className="title">
        <span className="accent">@</span>
        {username}
      </h1>
      <p className="muted">Bots, versions and rating history will show up here.</p>
    </section>
  );
}
