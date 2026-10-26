import { DEFAULT_VISION_RADIUS, LiveEngineSource, mountViewer } from "../src/index.ts";
import { demoBots } from "./bots.ts";

// `?seed=7` replays the same match; `?select=hunter%231` starts with a snake selected.
const params = new URLSearchParams(location.search);
const seed = Number(params.get("seed") ?? Math.floor(Math.random() * 1e9));

const source = new LiveEngineSource({
  bots: demoBots(DEFAULT_VISION_RADIUS),
  seed,
  title: `Live match · seed ${seed}`,
});

const viewer = mountViewer(document.getElementById("app") as HTMLElement, source, {
  keyboard: "window",
  ...(params.has("select") && { select: params.get("select") as string }),
});

// Handy from the console.
Object.assign(window, { viewer, source });
