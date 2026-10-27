import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { Participant } from "../queries/replay";
import { getReplayData } from "../server/pages";
import { Empty } from "./PageState";

type State =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "ready"; participants: Participant[]; desync: boolean };

/**
 * `@zerosnake/viewer` over a life's replay chunk. Client-only: the chunk, the viewer and
 * three.js are loaded after hydration, so none of it is in the server render or the main bundle.
 */
export function ReplayViewer({ lifeId, title }: { lifeId: string; title: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    setState({ kind: "loading" });

    (async () => {
      const data = await getReplayData({ data: lifeId });
      if (cancelled) return;
      if (data.status === "missing") {
        setState({ kind: "missing" });
        return;
      }
      const [{ mountViewer }, { SNAKE_PALETTE }, { ReplaySource }] = await Promise.all([
        import("@zerosnake/viewer"),
        import("@zerosnake/renderer"),
        import("../replay/ReplaySource"),
      ]);
      if (cancelled || !container.current) return;

      const byId = new Map(data.participants.map((p) => [p.id, p]));
      // One colour per bot version, in order of appearance, shared by its lives.
      const colors = new Map<string, string>();
      const source = new ReplaySource([decodeBase64(data.chunk)], {
        title,
        label: (snake) => {
          const p = byId.get(snake.id);
          const bot = p ? `${p.botName} v${p.version}` : snake.id.replace(/#\d+$/, "");
          let color = colors.get(bot);
          if (!color) {
            color = SNAKE_PALETTE[colors.size % SNAKE_PALETTE.length] as string;
            colors.set(bot, color);
          }
          return { bot, author: p?.author ?? snake.author, color };
        },
      });
      const life = source.life(lifeId);
      const viewer = mountViewer(container.current, source, {
        ...(life && { select: lifeId }),
      });
      if (life) viewer.playback.seek(Math.max(source.firstTick, life.bornTick));
      cleanup = () => {
        viewer.destroy();
        source.dispose();
      };
      setState({ kind: "ready", participants: data.participants, desync: !!source.desync });
    })().catch((e: unknown) => {
      if (!cancelled)
        setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [lifeId, title]);

  return (
    <>
      {state.kind === "ready" && state.desync && (
        <p className="warning">
          This replay was recorded by a different engine version. It plays, but may not show exactly
          what happened.
        </p>
      )}
      {state.kind === "missing" && <Empty>No recording was kept for this life.</Empty>}
      {state.kind === "error" && (
        <p className="error" role="alert">
          Couldn't play this replay: {state.message}
        </p>
      )}
      <div
        ref={container}
        className="replay-stage"
        hidden={state.kind === "missing" || state.kind === "error"}
      >
        {state.kind === "loading" && <span className="muted replay-loading">Loading replay…</span>}
      </div>
      {state.kind === "ready" && state.participants.length > 0 && (
        <div className="participants">
          <h2 className="subtitle">In this replay</h2>
          <ul className="chips">
            {uniqueBots(state.participants).map((p) => (
              <li key={`${p.author}/${p.botSlug}`}>
                <Link
                  to="/@{$username}/$bot"
                  params={{ username: p.author, bot: p.botSlug }}
                  className="chip"
                >
                  {p.botName} <span className="muted">@{p.author}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function uniqueBots(participants: Participant[]) {
  const seen = new Set<string>();
  return participants.filter((p) => {
    const key = `${p.author}/${p.botSlug}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function decodeBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
