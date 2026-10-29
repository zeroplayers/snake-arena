import { useEffect, useRef, useState } from "react";
import {
  canFullscreen,
  fullscreenElement,
  onFullscreenChange,
  toggleFullscreen,
} from "./fullscreen";
import type { HeroPlayer } from "./heroPlayer";
import type { HeroSource } from "./heroSource";

type State = "waiting" | "loading" | "playing" | "paused" | "failed";

/**
 * The landing page's arena. Client-only and lazy: the engine, house bots and three.js load once
 * the stage scrolls near the viewport, after hydration, so none of it is in the server render or
 * the main bundle. It only animates while on screen and the tab is visible, and starts paused
 * when the visitor prefers reduced motion; paused, it lets go of the live showcase's socket. What
 * it plays comes from `heroSource.ts`: the live showcase when a room is on, else a local match;
 * the caption says which. A showcase that goes away for good is replaced by a local match.
 * Expand puts the whole figure, caption and its buttons included, in full screen, which counts as
 * on screen; it's only offered where the browser can do it (not iPhone Safari).
 */
export function ArenaHero() {
  const figure = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const player = useRef<HeroPlayer | undefined>(undefined);
  // The visitor's own pause wins over visibility.
  const userPaused = useRef(false);
  const toggle = useRef(() => {});
  const [state, setState] = useState<State>("waiting");
  const [live, setLive] = useState(false);
  // Known only after mount, so the server markup and hydration agree: no button until then.
  const [expandable, setExpandable] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    let cancelled = false;
    let started = false;
    let onScreen = false;
    let expanded = false;
    let idle = false;
    let cancelIdle = () => {};
    userPaused.current = matchMedia("(prefers-reduced-motion: reduce)").matches;

    const sync = () => {
      const p = player.current;
      if (!p) return;
      const run = (onScreen || expanded) && !document.hidden && !userPaused.current;
      if (run) p.play();
      else p.pause();
      setState(userPaused.current ? "paused" : "playing");
    };

    const load = async () => {
      setState("loading");
      const [{ createHeroSource, localHeroSource }, { playHero }] = await Promise.all([
        import("./heroSource"),
        import("./heroPlayer"),
      ]);
      if (cancelled) return;
      const show = ({ source, live }: HeroSource) => {
        if (cancelled) {
          source.dispose?.();
          return;
        }
        player.current?.destroy();
        setLive(live);
        player.current = playHero(el, source);
        sync();
      };
      // The showcase closed and no other came: the house bots take over.
      const onLiveLost = () => {
        localHeroSource().then(show, () => !cancelled && setState("failed"));
      };
      show(await createHeroSource({ onLiveLost }));
    };

    const maybeLoad = () => {
      if (started || !idle || !onScreen) return;
      started = true;
      load().catch(() => !cancelled && setState("failed"));
    };

    const observer = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry?.isIntersecting ?? false;
        maybeLoad();
        sync();
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);

    // The page itself first: three.js and the engine wait until it has loaded and gone idle.
    const onIdle = () => {
      idle = true;
      maybeLoad();
    };
    const afterLoad = () => {
      if (typeof requestIdleCallback === "function") {
        const id = requestIdleCallback(onIdle, { timeout: 3000 });
        cancelIdle = () => cancelIdleCallback(id);
      } else {
        const id = window.setTimeout(onIdle, 500);
        cancelIdle = () => clearTimeout(id);
      }
    };
    if (document.readyState === "complete") afterLoad();
    else window.addEventListener("load", afterLoad, { once: true });
    document.addEventListener("visibilitychange", sync);
    setExpandable(canFullscreen());
    const offFullscreen = onFullscreenChange(() => {
      expanded = !!figure.current && fullscreenElement() === figure.current;
      setFullscreen(expanded);
      sync();
    });
    toggle.current = () => {
      userPaused.current = !userPaused.current;
      sync();
    };

    return () => {
      cancelled = true;
      observer.disconnect();
      window.removeEventListener("load", afterLoad);
      cancelIdle();
      document.removeEventListener("visibilitychange", sync);
      offFullscreen();
      player.current?.destroy();
      player.current = undefined;
    };
  }, []);

  const ready = state === "playing" || state === "paused";

  return (
    <figure ref={figure} className={fullscreen ? "hero-arena fullscreen" : "hero-arena"}>
      <div
        ref={stage}
        className="hero-stage"
        role="img"
        aria-label={
          live
            ? "Live match: snake bots playing in the arena"
            : "Demo match: house bots playing in the arena"
        }
      >
        {state === "failed" ? (
          <span className="muted hero-stage-note">
            This demo needs WebGL, which this browser doesn't provide.
          </span>
        ) : (
          state !== "playing" &&
          state !== "paused" && <span className="muted hero-stage-note">Loading the arena…</span>
        )}
      </div>
      <figcaption className="hero-caption">
        <span className="small muted">
          {live ? (
            <>
              <span className="live-dot" aria-hidden="true" /> Live from the arena
            </>
          ) : (
            "Demo: house bots on the real engine, in your browser"
          )}
        </span>
        <span className="hero-controls">
          {/* Always there, so the caption doesn't jump when the arena starts. */}
          <button
            type="button"
            className="button ghost small"
            disabled={!ready}
            aria-label={state === "paused" ? "Play the arena" : "Pause the arena"}
            onClick={() => toggle.current()}
          >
            {state === "paused" ? "Play" : "Pause"}
          </button>
          {expandable && (
            <button
              type="button"
              className="button ghost small"
              disabled={!ready}
              aria-label={fullscreen ? "Exit full screen" : "Watch the arena full screen"}
              onClick={() => figure.current && toggleFullscreen(figure.current)}
            >
              {fullscreen ? "Exit full screen" : "Expand"}
            </button>
          )}
        </span>
      </figcaption>
    </figure>
  );
}
