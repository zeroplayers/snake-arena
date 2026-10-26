import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/leaderboard")({
  head: () => ({ meta: [{ title: "Leaderboard · ZeroSnake Arena" }] }),
  component: Leaderboard,
});

function Leaderboard() {
  return (
    <section className="panel">
      <h1 className="title">Leaderboard</h1>
      <p className="muted">
        Versions enter the leaderboard after 30 lives. Rating is the mean score over the last 200.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>#</th>
            <th>Bot</th>
            <th>Author</th>
            <th className="num">Rating</th>
            <th className="num">Lives</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td colSpan={5} className="empty">
              No ranked bots yet.
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
