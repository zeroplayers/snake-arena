import { ArenaRenderer } from "@zerosnake/renderer";
import { followLive, type MatchSource, Playback } from "@zerosnake/viewer";
import { holdLive } from "./heroSource";

export interface HeroPlayer {
  play(): void;
  pause(): void;
  readonly playing: boolean;
  destroy(): void;
}

/**
 * Plays a `MatchSource` on a bare arena canvas: no timeline or panels, the camera on the whole
 * disc, from the source's newest tick. `Playback` keeps the clock, so a live broadcast and a
 * local engine play the same way; a broadcast is kept a little behind its newest tick
 * (`followLive`) so its bursts play smoothly. A finished recording starts over. Paused (scrolled
 * away, a hidden tab, the visitor's pause), a live source closes its socket (`holdLive`), so no
 * room stays in real time for nobody; playing again reconnects at the newest tick. The renderer
 * follows the container's size (full screen and back); resizing clears the canvas, so a paused
 * arena draws its frame again at the new size.
 */
export function playHero(container: HTMLElement, source: MatchSource): HeroPlayer {
  const renderer = new ArenaRenderer(container, { tps: source.info.tps, maxPixelRatio: 1.5 });
  const playback = new Playback(source);
  playback.seek(source.lastTick);
  let raf = 0;
  let last: number | undefined;

  const draw = () => {
    const sample = playback.sample();
    if (sample) renderer.draw(sample.prev.frame, sample.next.frame, sample.alpha);
  };
  const frame = (now: number) => {
    const dt = last === undefined ? 0 : Math.min(0.1, (now - last) / 1000);
    last = now;
    followLive(playback);
    playback.update(dt);
    if (source.endTick !== undefined && playback.position >= source.endTick) {
      playback.seek(source.firstTick);
      playback.play();
    }
    draw();
    raf = requestAnimationFrame(frame);
  };
  draw();
  // Created after the renderer's own observer, so this runs after it has resized.
  const resized = new ResizeObserver(() => {
    if (!raf) draw();
  });
  resized.observe(container);

  return {
    play() {
      if (raf) return;
      holdLive(source, true);
      last = undefined;
      raf = requestAnimationFrame(frame);
    },
    pause() {
      cancelAnimationFrame(raf);
      raf = 0;
      holdLive(source, false);
    },
    get playing() {
      return raf !== 0;
    },
    destroy() {
      cancelAnimationFrame(raf);
      raf = 0;
      resized.disconnect();
      renderer.destroy();
      source.dispose?.();
    },
  };
}
