import { ArenaRenderer } from "../src/index.ts";
import { FakeWorld } from "./fakeWorld.ts";

const TPS = 10;

const app = document.getElementById("app") as HTMLElement;
const hud = document.getElementById("hud") as HTMLElement;
const overviewButton = document.getElementById("overview") as HTMLButtonElement;
const followButton = document.getElementById("follow") as HTMLButtonElement;
const pauseButton = document.getElementById("pause") as HTMLButtonElement;

const world = new FakeWorld();
const renderer = new ArenaRenderer(app, { tps: TPS, camera: { mode: "follow", snakeId: "bot-0" } });
renderer.push(world.frame());
renderer.start();

let paused = false;
setInterval(() => {
  if (paused) return;
  world.step();
  renderer.push(world.frame());
}, 1000 / TPS);

function overview(): void {
  renderer.setCamera({ mode: "overview" });
}

function followNext(step = 1): void {
  const ids = world.snakeIds;
  const camera = renderer.getCamera();
  const current = camera.mode === "follow" ? ids.indexOf(camera.snakeId) : -1;
  const next = ids[(current + step + ids.length) % ids.length];
  if (next) renderer.setCamera({ mode: "follow", snakeId: next });
}

function togglePause(): void {
  paused = !paused;
  pauseButton.textContent = paused ? "Resume" : "Pause";
}

overviewButton.addEventListener("click", overview);
followButton.addEventListener("click", () => followNext());
pauseButton.addEventListener("click", togglePause);

window.addEventListener("keydown", (e) => {
  if (e.key === "o") overview();
  else if (e.key === "f" || e.key === "Tab") {
    e.preventDefault();
    followNext(e.shiftKey ? -1 : 1);
  } else if (e.key === " ") togglePause();
  else if (e.key === "+" || e.key === "=") renderer.setZoom(renderer.getZoom() * 1.25);
  else if (e.key === "-") renderer.setZoom(renderer.getZoom() / 1.25);
});

app.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    renderer.setZoom(renderer.getZoom() * Math.exp(-e.deltaY * 0.001));
  },
  { passive: false },
);

// HUD: display fps and what the camera is doing.
let frames = 0;
let fps = 0;
let last = performance.now();
function updateHud(now: number): void {
  frames++;
  if (now - last >= 500) {
    fps = (frames * 1000) / (now - last);
    frames = 0;
    last = now;
  }
  const camera = renderer.getCamera();
  const mode = camera.mode === "follow" ? `follow ${camera.snakeId}` : "overview";
  hud.textContent = `tick ${renderer.displayTick.toFixed(2)} · ${fps.toFixed(0)} fps · ${mode} · zoom ${renderer.getZoom().toFixed(2)}×`;
  requestAnimationFrame(updateHud);
}
requestAnimationFrame(updateHud);
