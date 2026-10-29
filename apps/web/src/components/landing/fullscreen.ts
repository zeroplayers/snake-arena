/**
 * The Fullscreen API with Safari's prefixed fallback. iPhone Safari has neither for anything but
 * video, so `canFullscreen` is false there and the hero shows no Expand button. Everything takes
 * the document, so tests can pass a fake.
 */

interface FullscreenDocument {
  readonly fullscreenEnabled?: boolean;
  readonly webkitFullscreenEnabled?: boolean;
  readonly fullscreenElement?: Element | null;
  readonly webkitFullscreenElement?: Element | null;
  exitFullscreen?(): Promise<void>;
  webkitExitFullscreen?(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

interface FullscreenElement {
  requestFullscreen?(): Promise<void>;
  webkitRequestFullscreen?(): void;
}

const CHANGE_EVENTS = ["fullscreenchange", "webkitfullscreenchange"];

export function canFullscreen(doc: FullscreenDocument = document): boolean {
  return !!(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);
}

export function fullscreenElement(doc: FullscreenDocument = document): Element | null {
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/** Leaves full screen if anything is in it, else puts `el` in it. */
export function toggleFullscreen(el: FullscreenElement, doc: FullscreenDocument = document): void {
  // A refusal (no user gesture, a permissions policy) just leaves the page as it was.
  const ignore = () => {};
  if (fullscreenElement(doc)) {
    if (doc.exitFullscreen) doc.exitFullscreen().catch(ignore);
    else doc.webkitExitFullscreen?.();
  } else if (el.requestFullscreen) el.requestFullscreen().catch(ignore);
  else el.webkitRequestFullscreen?.();
}

/** Calls `listener` on entering and leaving full screen (Esc included); returns the unsubscribe. */
export function onFullscreenChange(
  listener: () => void,
  doc: FullscreenDocument = document,
): () => void {
  for (const type of CHANGE_EVENTS) doc.addEventListener(type, listener);
  return () => {
    for (const type of CHANGE_EVENTS) doc.removeEventListener(type, listener);
  };
}
