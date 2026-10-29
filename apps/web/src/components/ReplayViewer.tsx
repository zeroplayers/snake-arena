import { Link } from "@tanstack/react-router";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import type { Participant } from "../queries/replay";
import type { ReplaySource } from "../replay/ReplaySource";
import type { ReplayTrace } from "../server/traces";
import { REPLAY_EXPIRED_MESSAGE, type ReplayResponse } from "../shared/replay";
import { type TraceTick, traceTicks } from "../shared/trace";
import { Empty } from "./PageState";

type State =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "expired" }
  | { kind: "error"; message: string }
  | { kind: "ready"; participants: Participant[]; desync: boolean };

/**
 * `@zerosnake/viewer` over a life's replay window (its last 10 minutes at most,
 * `src/shared/replay.ts`). Client-only: the chunks, the viewer and three.js are loaded after
 * hydration, so none of it is in the server render or the main bundle.
 *
 * With the life's `trace` (its owner's), the viewer's log panel shows what the bot logged. `seek`
 * is set to a function that shows a room tick, once the viewer is up.
 */
export function ReplayViewer({
  lifeId,
  title,
  trace,
  seek,
}: {
  lifeId: string;
  title: string;
  trace?: ReplayTrace | null;
  seek?: RefObject<((tick: number) => void) | null>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>({ kind: "loading" });
  const sourceRef = useRef<ReplaySource | null>(null);
  const ticks: TraceTick[] | null = useMemo(
    () => (trace?.status === "ok" ? traceTicks(trace.trace) : null),
    [trace],
  );

  useEffect(() => {
    if (ticks && state.kind === "ready") sourceRef.current?.setTrace(lifeId, ticks);
  }, [ticks, state.kind, lifeId]);

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    setState({ kind: "loading" });

    (async () => {
      const response = await fetch(`/api/lives/${encodeURIComponent(lifeId)}/replay`);
      if (cancelled) return;
      // 410: deleted by the replay retention (`src/shared/replay.ts`); 404: never recorded.
      if (response.status === 410 || response.status === 404) {
        setState({ kind: response.status === 410 ? "expired" : "missing" });
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as ReplayResponse;
      if (cancelled) return;
      const [{ mountViewer }, { SNAKE_PALETTE }, { ReplaySource }] = await Promise.all([
        import("@zerosnake/viewer"),
        import("@zerosnake/renderer"),
        import("../replay/ReplaySource"),
      ]);
      if (cancelled || !container.current) return;

      const byId = new Map(data.participants.map((p) => [p.id, p]));
      // One colour per bot version, in order of appearance, shared by its lives.
      const colors = new Map<string, string>();
      const source = new ReplaySource(data.chunks.map(decodeBase64), {
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
      sourceRef.current = source;
      if (seek) {
        seek.current = (tick) => {
          viewer.select(lifeId);
          viewer.playback.pause();
          viewer.playback.seek(Math.min(Math.max(tick, source.firstTick), source.lastTick));
          container.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        };
      }
      cleanup = () => {
        if (seek) seek.current = null;
        sourceRef.current = null;
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
  }, [lifeId, title, seek]);

  return (
    <>
      {state.kind === "ready" && state.desync && (
        <p className="warning">
          This replay was recorded by a different engine version. It plays, but may not show exactly
          what happened.
        </p>
      )}
      {state.kind === "missing" && <Empty>No recording was kept for this life.</Empty>}
      {state.kind === "expired" && <Empty>{REPLAY_EXPIRED_MESSAGE}</Empty>}
      {state.kind === "error" && (
        <p className="error" role="alert">
          Couldn't play this replay: {state.message}
        </p>
      )}
      <div
        ref={container}
        className="replay-stage"
        hidden={state.kind === "missing" || state.kind === "expired" || state.kind === "error"}
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
