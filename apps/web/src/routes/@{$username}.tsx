import { createFileRoute, notFound } from "@tanstack/react-router";
import { getProfileData } from "../server/functions";

export const Route = createFileRoute("/@{$username}")({
  loader: async ({ params }) => {
    const profile = await getProfileData({ data: params.username });
    if (!profile) throw notFound();
    return profile;
  },
  head: ({ params }) => ({ meta: [{ title: `@${params.username} · ZeroSnake Arena` }] }),
  component: ProfilePage,
});

const joined = new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" });

function ProfilePage() {
  const profile = Route.useLoaderData();
  return (
    <section className="panel">
      <div className="profile-head">
        {profile.avatarUrl && <img className="avatar" src={profile.avatarUrl} alt="" />}
        <div>
          <h1 className="title">
            <span className="accent">@</span>
            {profile.username}
          </h1>
          <span className="muted">Joined {joined.format(new Date(profile.joinedAt))}</span>
        </div>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Bot</th>
            <th className="num">Version</th>
            <th className="num">Rating</th>
            <th className="num">Lives</th>
          </tr>
        </thead>
        <tbody>
          {profile.bots.length === 0 ? (
            <tr>
              <td colSpan={4} className="empty">
                No bots yet.
              </td>
            </tr>
          ) : (
            profile.bots.map((bot) => (
              <tr key={bot.id}>
                <td>{bot.name}</td>
                <td className="num">{bot.activeVersion ? `v${bot.activeVersion}` : "—"}</td>
                <td className="num">{bot.rating === null ? "—" : bot.rating.toFixed(1)}</td>
                <td className="num">{bot.lives}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  );
}
