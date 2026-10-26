/**
 * The viewer page of `zerosnake sim`, bundled for the browser by the CLI's local server. It
 * polls the server for replay chunks while the match runs in Node and plays them back.
 */
import { mountViewer } from "@zerosnake/viewer";
import type { MatchUpdate } from "./protocol.ts";
import { RecordedMatchSource } from "./source.ts";

const POLL_MS = 250;

const app = document.getElementById("app") as HTMLElement;
const status = document.getElementById("status") as HTMLElement;

function decode(data: string): Uint8Array {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function fetchUpdate(from: number): Promise<MatchUpdate> {
  const res = await fetch(`/api/match?from=${from}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`the CLI answered ${res.status}`);
  return (await res.json()) as MatchUpdate;
}

function apply(source: RecordedMatchSource, update: MatchUpdate): void {
  if (update.from !== source.chunkCount) return; // A stale answer; the next poll catches up.
  source.append(
    update.chunks.map((c) => ({ bytes: decode(c.data), calls: c.calls })),
    update.lives,
  );
  if (update.done) source.finish();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  let update = await fetchUpdate(0);
  const source = new RecordedMatchSource(update.info, update.bots);
  apply(source, update);
  document.title = update.info.title ?? document.title;
  // The viewer needs a first tick to show.
  while (source.chunkCount === 0 && !update.done) {
    await sleep(POLL_MS);
    update = await fetchUpdate(0);
    apply(source, update);
  }
  if (update.error) throw new Error(update.error);
  status.remove();

  const you = source.lives().find((l) => (l as { you?: boolean }).you);
  const viewer = mountViewer(app, source, {
    keyboard: "window",
    ...(you && { select: you.id }),
  });
  Object.assign(window, { viewer, source });

  while (!update.done) {
    await sleep(POLL_MS);
    try {
      update = await fetchUpdate(source.chunkCount);
      apply(source, update);
    } catch {
      // The CLI stopped (Ctrl+C): keep showing what we have.
      return;
    }
  }
}

main().catch((e: unknown) => {
  status.textContent = `Couldn't load the match: ${e instanceof Error ? e.message : String(e)}`;
});
