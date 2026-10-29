import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ArenaHero } from "./ArenaHero";
import {
  canFullscreen,
  fullscreenElement,
  onFullscreenChange,
  toggleFullscreen,
} from "./fullscreen";

/** A document with only what `fullscreen.ts` reads. */
function fakeDocument(fields: Record<string, unknown> = {}) {
  const events = new EventTarget();
  return {
    addEventListener: (type: string, listener: () => void) =>
      events.addEventListener(type, listener),
    removeEventListener: (type: string, listener: () => void) =>
      events.removeEventListener(type, listener),
    dispatch: (type: string) => events.dispatchEvent(new Event(type)),
    ...fields,
  };
}

const element = {} as Element;

describe("full screen", () => {
  it("is offered only where the browser can do it, prefixed or not", () => {
    expect(canFullscreen(fakeDocument())).toBe(false);
    expect(canFullscreen(fakeDocument({ fullscreenEnabled: false }))).toBe(false);
    expect(canFullscreen(fakeDocument({ fullscreenEnabled: true }))).toBe(true);
    expect(canFullscreen(fakeDocument({ webkitFullscreenEnabled: true }))).toBe(true);
  });

  it("has no Expand button in the server render, before support is known", () => {
    const html = renderToString(<ArenaHero />);
    expect(html).toContain("Pause");
    expect(html).not.toContain("Expand");
    expect(html).not.toContain("full screen");
  });

  it("requests full screen on the element, and exits when something is in it", () => {
    const requestFullscreen = vi.fn(() => Promise.resolve());
    const exitFullscreen = vi.fn(() => Promise.resolve());
    toggleFullscreen(
      { requestFullscreen },
      fakeDocument({ fullscreenElement: null, exitFullscreen }),
    );
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(exitFullscreen).not.toHaveBeenCalled();

    toggleFullscreen(
      { requestFullscreen },
      fakeDocument({ fullscreenElement: element, exitFullscreen }),
    );
    expect(exitFullscreen).toHaveBeenCalledOnce();
    expect(requestFullscreen).toHaveBeenCalledOnce();
  });

  it("falls back to Safari's prefixed API", () => {
    const webkitRequestFullscreen = vi.fn();
    const webkitExitFullscreen = vi.fn();
    toggleFullscreen({ webkitRequestFullscreen }, fakeDocument({ webkitExitFullscreen }));
    expect(webkitRequestFullscreen).toHaveBeenCalledOnce();

    const doc = fakeDocument({ webkitFullscreenElement: element, webkitExitFullscreen });
    expect(fullscreenElement(doc)).toBe(element);
    toggleFullscreen({ webkitRequestFullscreen }, doc);
    expect(webkitExitFullscreen).toHaveBeenCalledOnce();
  });

  it("swallows a refused request", async () => {
    const requestFullscreen = vi.fn(() => Promise.reject(new TypeError("not allowed")));
    expect(() => toggleFullscreen({ requestFullscreen }, fakeDocument())).not.toThrow();
    // The rejection is handled: nothing surfaces as unhandled.
    await Promise.resolve();
  });

  it("hears entering and leaving, prefixed or not, until unsubscribed", () => {
    const doc = fakeDocument();
    const listener = vi.fn();
    const off = onFullscreenChange(listener, doc);
    doc.dispatch("fullscreenchange");
    doc.dispatch("webkitfullscreenchange");
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    doc.dispatch("fullscreenchange");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
