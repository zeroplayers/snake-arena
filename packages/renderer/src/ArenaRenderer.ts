import { OrthographicCamera, Scene, WebGLRenderer } from "three";
import { FrameBuffer, lerp } from "./interpolate.ts";
import { BackgroundRenderer, DEFAULT_BACKGROUND } from "./renderers/BackgroundRenderer.ts";
import { FoodRenderer } from "./renderers/FoodRenderer.ts";
import { HighlightRenderer } from "./renderers/HighlightRenderer.ts";
import { SnakeRenderer } from "./renderers/SnakeRenderer.ts";
import { SkinTextures } from "./skins/index.ts";
import type { CameraMode, Highlight, RenderFrame, Vec2 } from "./types.ts";

export interface RendererOptions {
  /** Simulation ticks per second of frames fed through `push`. Default 10. */
  readonly tps?: number;
  /** Distance between background grid dots, world units. Default 2.1 (ZeroSnake scale). */
  readonly gridCellSize?: number;
  /** Arena wall width, world units. */
  readonly borderWidth?: number;
  /** Distance between drawn body circles, in snake radii. Default 1.4 (the original look). */
  readonly segmentSpacing?: number;
  /** Upper bound on devicePixelRatio. Default 2. */
  readonly maxPixelRatio?: number;
  readonly camera?: CameraMode;
}

/** Visible height in the follow camera, in snake radii, before growth and zoom. */
const FOLLOW_VIEW_RADII = 28;
const CAMERA_MOVE_RATE = 8; // 1/s, exponential smoothing
const CAMERA_ZOOM_RATE = 4;
const OVERVIEW_MARGIN = 1.06;

/**
 * Draws a ZeroSnake Arena world with three.js. Ported from ZeroSnake's ThreeJSRenderer,
 * without Colyseus or React: feed it `RenderFrame`s.
 *
 * Live: `push(frame)` every tick and `start()`; frames are buffered and interpolated to the
 * display rate. Replays/scrubbing: call `draw(prev, next, alpha)` yourself and skip `start()`.
 */
export class ArenaRenderer {
  readonly domElement: HTMLCanvasElement;

  private readonly webgl: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
  private readonly textures = new SkinTextures();
  private readonly background: BackgroundRenderer;
  private readonly food: FoodRenderer;
  private readonly snakes: SnakeRenderer;
  private readonly highlighter: HighlightRenderer;
  private readonly buffer: FrameBuffer;
  private readonly resizeObserver: ResizeObserver;

  private cameraMode: CameraMode;
  private highlight: Highlight | undefined;
  private zoom = 1;
  private viewHeight = 0; // 0 = snap on the next draw
  private width = 1;
  private height = 1;
  private lastTime: number | undefined;
  private lastDrawTime: number | undefined;
  private tick = 0;

  constructor(
    private readonly container: HTMLElement,
    options: RendererOptions = {},
  ) {
    this.cameraMode = options.camera ?? { mode: "overview" };
    this.buffer = new FrameBuffer(options.tps ?? 10);

    this.webgl = new WebGLRenderer({ antialias: true });
    this.webgl.setPixelRatio(Math.min(window.devicePixelRatio, options.maxPixelRatio ?? 2));
    this.domElement = this.webgl.domElement;
    this.domElement.style.display = "block";
    container.appendChild(this.domElement);

    this.camera.position.z = 50;
    this.background = new BackgroundRenderer(this.scene, {
      ...DEFAULT_BACKGROUND,
      ...(options.gridCellSize !== undefined && {
        cellSize: options.gridCellSize,
        dotRadius:
          (DEFAULT_BACKGROUND.dotRadius / DEFAULT_BACKGROUND.cellSize) * options.gridCellSize,
      }),
      ...(options.borderWidth !== undefined && { borderWidth: options.borderWidth }),
    });
    this.food = new FoodRenderer(this.scene, this.textures);
    this.snakes = new SnakeRenderer(this.scene, this.textures, options.segmentSpacing ?? 1.4);
    this.highlighter = new HighlightRenderer(this.scene);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  /** Queues a tick for interpolated playback (see `start`). */
  push(frame: RenderFrame): void {
    this.buffer.push(frame);
  }

  /** Runs the display loop, playing pushed frames back smoothly. */
  start(): void {
    this.webgl.setAnimationLoop((time) => {
      const dt = this.lastTime === undefined ? 0 : Math.min(0.1, (time - this.lastTime) / 1000);
      this.lastTime = time;
      const sample = this.buffer.advance(dt);
      if (sample) this.draw(sample.prev, sample.next, sample.alpha);
    });
  }

  stop(): void {
    this.webgl.setAnimationLoop(null);
    this.lastTime = undefined;
  }

  /** Draws the world `alpha` of the way from `prev` to `next` (two consecutive ticks). */
  draw(prev: RenderFrame, next: RenderFrame, alpha: number): void {
    const now = performance.now();
    const dt =
      this.lastDrawTime === undefined ? 0 : Math.min(0.1, (now - this.lastDrawTime) / 1000);
    this.lastDrawTime = now;
    this.tick = lerp(prev.tick, next.tick, alpha);

    const arenaHalfSize = next.arenaHalfSize;
    const onTop =
      this.highlight?.snakeId ??
      (this.cameraMode.mode === "follow" ? this.cameraMode.snakeId : undefined);
    this.background.setArenaHalfSize(arenaHalfSize);
    this.background.update(dt);
    this.snakes.update(prev.snakes, next.snakes, alpha, onTop);
    this.highlighter.update(
      this.highlight,
      this.highlight && this.snakes.view(this.highlight.snakeId),
    );
    this.food.update(prev.food, next.food, alpha, this.snakes.headPositions(), dt);
    this.updateCamera(dt, arenaHalfSize);
    this.webgl.render(this.scene, this.camera);
  }

  setCamera(mode: CameraMode): void {
    this.cameraMode = mode;
  }

  getCamera(): CameraMode {
    return this.cameraMode;
  }

  /** Draws a disc around a snake's head (e.g. its vision radius); `undefined` removes it. */
  setHighlight(highlight: Highlight | undefined): void {
    this.highlight = highlight;
  }

  /** World position under a point in client (CSS pixel) coordinates, as of the last draw. */
  screenToWorld(clientX: number, clientY: number): Vec2 {
    const rect = this.domElement.getBoundingClientRect();
    const nx = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    const ny = 1 - ((clientY - rect.top) / Math.max(1, rect.height)) * 2;
    return {
      x: this.camera.position.x + nx * this.camera.right,
      y: this.camera.position.y + ny * this.camera.top,
    };
  }

  /** Extra zoom on top of the camera mode's own; > 1 zooms in. */
  setZoom(zoom: number): void {
    this.zoom = Math.max(0.1, Math.min(10, zoom));
  }

  getZoom(): number {
    return this.zoom;
  }

  /** Fractional tick currently on screen. */
  get displayTick(): number {
    return this.tick;
  }

  destroy(): void {
    this.stop();
    this.resizeObserver.disconnect();
    this.snakes.destroy();
    this.highlighter.destroy();
    this.food.destroy();
    this.background.destroy();
    this.textures.dispose();
    this.webgl.dispose();
    this.domElement.remove();
  }

  private updateCamera(dt: number, arenaHalfSize: number): void {
    const aspect = this.width / this.height;
    let x = 0;
    let y = 0;
    // Overview fits the whole square, wall glow included, whichever side of the screen is
    // shorter: in a square view it fills the frame.
    let height = (this.background.extent(arenaHalfSize) * 2) / Math.min(1, aspect);

    if (this.cameraMode.mode === "follow") {
      const view = this.snakes.view(this.cameraMode.snakeId);
      if (view) {
        x = view.x;
        y = view.y;
        // Zoom out as the snake grows, like the original's per-player zoom.
        height = view.radius * (FOLLOW_VIEW_RADII + Math.sqrt(view.length) * 1.5);
        const minRadius = this.cameraMode.minViewRadius ?? 0;
        height = Math.max(height, (minRadius * 2 * OVERVIEW_MARGIN) / Math.min(1, aspect));
      } else {
        // Followed snake is gone (dead, not spawned yet): hold position.
        x = this.camera.position.x;
        y = this.camera.position.y;
        height = this.viewHeight || height;
      }
    }
    height /= this.zoom;

    if (this.viewHeight === 0) {
      this.camera.position.x = x;
      this.camera.position.y = y;
      this.viewHeight = height;
    } else {
      const move = 1 - Math.exp(-dt * CAMERA_MOVE_RATE);
      const zoom = 1 - Math.exp(-dt * CAMERA_ZOOM_RATE);
      this.camera.position.x = lerp(this.camera.position.x, x, move);
      this.camera.position.y = lerp(this.camera.position.y, y, move);
      this.viewHeight = Math.exp(lerp(Math.log(this.viewHeight), Math.log(height), zoom));
    }

    const halfH = this.viewHeight / 2;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.left = -halfH * aspect;
    this.camera.right = halfH * aspect;
    this.camera.updateProjectionMatrix();
  }

  private resize(): void {
    this.width = Math.max(1, this.container.clientWidth);
    this.height = Math.max(1, this.container.clientHeight);
    this.webgl.setSize(this.width, this.height);
  }
}
