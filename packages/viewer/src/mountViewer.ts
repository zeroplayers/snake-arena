import { ArenaRenderer, type RendererOptions } from "@zerosnake/renderer";
import { lifeAt, pickSnake, ranking, recentDeaths, recentLogs } from "./inspect.ts";
import { Playback, SPEEDS } from "./Playback.ts";
import type { LifeInfo, MatchSource, TickSnapshot } from "./types.ts";
import { button, fmt, h, swatch } from "./ui/dom.ts";
import { injectStyles } from "./ui/styles.ts";

export interface ViewerOptions {
  /** Life to select on start. */
  readonly select?: string;
  /** Start paused. Default false. */
  readonly paused?: boolean;
  /** Initial speed multiplier. Default 1. */
  readonly speed?: number;
  /** Follow the selected snake with the camera. Default true. */
  readonly follow?: boolean;
  /** Draw the selected snake's vision radius. Default true. */
  readonly showVision?: boolean;
  /**
   * Where keyboard shortcuts listen: the viewer element once focused (default; right for
   * embedding in a page), the whole window (a full-page viewer such as `zerosnake sim`), or off.
   */
  readonly keyboard?: "focus" | "window" | "off";
  readonly renderer?: RendererOptions;
}

export interface ViewerHandle {
  readonly playback: Playback;
  readonly renderer: ArenaRenderer;
  readonly element: HTMLElement;
  select(lifeId: string | undefined): void;
  readonly selected: string | undefined;
  destroy(): void;
}

/** Recent deaths listed under the ranking. */
const DEATHS_LISTED = 6;
/** UI panels refresh at most this often (the canvas and timeline run every frame). */
const PANEL_INTERVAL_MS = 100;

/**
 * Mounts a match viewer into `container`: canvas, timeline, snake list and a panel for the
 * selected snake. `source` decides what is shown (a live engine now, a replay later).
 */
export function mountViewer(
  container: HTMLElement,
  source: MatchSource,
  options: ViewerOptions = {},
): ViewerHandle {
  return new Viewer(container, source, options);
}

class Viewer implements ViewerHandle {
  readonly playback: Playback;
  readonly renderer: ArenaRenderer;
  readonly element: HTMLElement;

  private selectedId: string | undefined;
  private follow: boolean;
  private showVision: boolean;
  private scrubbing: { wasPaused: boolean } | undefined;
  private raf = 0;
  private lastFrame: number | undefined;
  private lastPanel = 0;
  private panelKey = "";
  private readonly deathMarks = new Map<string, { el: HTMLElement; tick: number }>();
  private readonly bornMark = h("div", { class: "zsv-marker zsv-born" });
  private markedId: string | undefined;
  private fps = 0;
  private fpsFrames = 0;
  private fpsSince = 0;
  private readonly cleanup: (() => void)[] = [];

  // Elements updated every frame or panel refresh.
  private readonly stage: HTMLElement;
  private readonly hudText: HTMLElement;
  private readonly overviewBtn: HTMLButtonElement;
  private readonly followBtn: HTMLButtonElement;
  private readonly visionBtn: HTMLButtonElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly liveBtn: HTMLButtonElement;
  private readonly speedSelect: HTMLSelectElement;
  private readonly range: HTMLInputElement;
  private readonly markers: HTMLElement;
  private readonly tickLabel: HTMLElement;
  private readonly title: HTMLElement;
  private readonly list: HTMLElement;
  private readonly panel: HTMLElement;
  /** Built once so buttons survive the per-tick refresh (a rebuilt button loses its click). */
  private readonly panelParts: {
    empty: HTMLElement;
    info: HTMLElement;
    buttons: HTMLElement;
    deathBtn: HTMLButtonElement;
    logSection: HTMLElement;
    logBox: HTMLElement;
  };

  constructor(
    container: HTMLElement,
    private readonly source: MatchSource,
    options: ViewerOptions,
  ) {
    injectStyles(container.ownerDocument);
    this.playback = new Playback(source);
    if (options.speed !== undefined) this.playback.setSpeed(options.speed);
    if (options.paused) this.playback.pause();
    this.follow = options.follow ?? true;
    this.showVision = options.showVision ?? true;
    this.selectedId = options.select;

    // --- Stage -------------------------------------------------------------------------
    this.stage = h("div", { class: "zsv-stage" });
    this.hudText = h("span", { class: "zsv-hud-text" });
    this.overviewBtn = button("Overview", "Whole arena (O)", () => this.setFollow(false));
    this.followBtn = button("Follow", "Follow the selected snake (F)", () => this.setFollow(true));
    this.visionBtn = button("Vision", "Show the selected snake's vision radius (V)", () => {
      this.showVision = !this.showVision;
      this.applyCamera();
    });
    const hud = h(
      "div",
      { class: "zsv-hud" },
      this.overviewBtn,
      this.followBtn,
      this.visionBtn,
      this.hudText,
    );
    this.stage.append(hud);

    // --- Bottom bar --------------------------------------------------------------------
    this.playBtn = button("Pause", "Play / pause (Space)", () => this.playback.toggle());
    this.playBtn.style.minWidth = "6.5em";
    const back = button("◀", "Previous tick (←, Shift for 10)", () => this.playback.stepBy(-1));
    const fwd = button("▶", "Next tick (→, Shift for 10)", () => this.playback.stepBy(1));
    this.speedSelect = h("select", { class: "zsv-select", title: "Speed ([ and ])" });
    for (const s of SPEEDS) this.speedSelect.append(h("option", { value: String(s) }, `${s}×`));
    this.speedSelect.addEventListener("change", () =>
      this.playback.setSpeed(Number(this.speedSelect.value)),
    );
    this.range = h("input", {
      type: "range",
      class: "zsv-range",
      min: "0",
      max: "0",
      step: "1",
      "aria-label": "Tick",
    });
    this.markers = h("div", { class: "zsv-markers" }, this.bornMark);
    const timeline = h("div", { class: "zsv-timeline" }, this.markers, this.range);
    this.tickLabel = h("span", { class: "zsv-tick" });
    this.liveBtn = button("Live", "Jump to the newest tick (L)", () => this.playback.goLive());
    const bar = h(
      "div",
      { class: "zsv-bar" },
      this.playBtn,
      back,
      fwd,
      this.speedSelect,
      timeline,
      this.tickLabel,
      source.endTick === undefined && this.liveBtn,
    );

    // --- Sidebar -----------------------------------------------------------------------
    this.title = h("div", { class: "zsv-title" }, source.info.title ?? "Match");
    this.list = h("div", { class: "zsv-section zsv-list" });
    const deathBtn = button(
      "Jump to death",
      "Play the last seconds before this snake died (D)",
      () => this.jumpToDeath(),
    );
    const buttons = h(
      "div",
      { class: "zsv-actions" },
      deathBtn,
      button("Deselect", "Clear the selection (Esc)", () => this.select(undefined)),
    );
    const info = h("div");
    const logBox = h("pre", { class: "zsv-logs" });
    const logSection = h(
      "div",
      { class: "zsv-section zsv-logs-section" },
      h("h3", {}, "log()"),
      logBox,
    );
    const empty = h(
      "div",
      { class: "zsv-empty" },
      "Click a snake (on the arena or in the list) to see its stats, vision, actions and logs.",
    );
    this.panelParts = { empty, info, buttons, deathBtn, logSection, logBox };
    this.panel = h(
      "div",
      { class: "zsv-panel" },
      h("div", { class: "zsv-section" }, empty, info, buttons),
      logSection,
    );
    const side = h(
      "div",
      { class: "zsv-side" },
      h("div", { class: "zsv-section" }, this.title),
      this.list,
      this.panel,
    );

    this.element = h("div", { class: "zsv", tabindex: "0" }, this.stage, bar, side);
    container.append(this.element);
    this.renderer = new ArenaRenderer(this.stage, { tps: source.info.tps, ...options.renderer });
    // The HUD sits above the canvas the renderer appended.
    this.stage.append(hud);

    this.bindEvents(options.keyboard ?? "focus");
    this.applyCamera();
    this.raf = requestAnimationFrame(this.frame);
  }

  get selected(): string | undefined {
    return this.selectedId;
  }

  select(lifeId: string | undefined): void {
    this.selectedId = lifeId;
    this.panelKey = "";
    this.applyCamera();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    for (const fn of this.cleanup) fn();
    this.renderer.destroy();
    this.element.remove();
  }

  private setFollow(follow: boolean): void {
    this.follow = follow;
    this.applyCamera();
  }

  private applyCamera(): void {
    const id = this.selectedId;
    const life = id === undefined ? undefined : this.source.life(id);
    const vision = this.source.info.visionRadius;
    if (id !== undefined && this.follow) {
      this.renderer.setCamera({
        mode: "follow",
        snakeId: id,
        ...(this.showVision && { minViewRadius: vision * 1.1 }),
      });
    } else {
      this.renderer.setCamera({ mode: "overview" });
    }
    this.renderer.setHighlight(
      id !== undefined && this.showVision
        ? { snakeId: id, radius: vision, ...(life && { color: life.color }) }
        : undefined,
    );
    const following = id !== undefined && this.follow;
    this.overviewBtn.setAttribute("aria-pressed", String(!following));
    this.followBtn.setAttribute("aria-pressed", String(following));
    this.followBtn.disabled = id === undefined;
    this.visionBtn.setAttribute("aria-pressed", String(this.showVision));
    this.visionBtn.disabled = id === undefined;
  }

  private readonly frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = this.lastFrame === undefined ? 0 : Math.min(0.25, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (!this.scrubbing) this.playback.update(dt);

    const sample = this.playback.sample();
    if (sample) this.renderer.draw(sample.prev.frame, sample.next.frame, sample.alpha);

    this.fpsFrames++;
    if (now - this.fpsSince >= 500) {
      this.fps = (this.fpsFrames * 1000) / (now - this.fpsSince);
      this.fpsFrames = 0;
      this.fpsSince = now;
    }
    this.updateBar();
    if (now - this.lastPanel >= PANEL_INTERVAL_MS) {
      this.lastPanel = now;
      this.updatePanels();
    }
  };

  private updateBar(): void {
    const p = this.playback;
    const s = this.source;
    this.playBtn.textContent = p.isPaused ? "Play" : "Pause";
    if (this.range.min !== String(s.firstTick)) this.range.min = String(s.firstTick);
    if (this.range.max !== String(s.lastTick)) this.range.max = String(s.lastTick);
    if (!this.scrubbing) this.range.value = String(p.tick);
    const total = s.endTick ?? s.lastTick;
    this.tickLabel.textContent = `${p.tick} / ${total}`;
    this.liveBtn.setAttribute("aria-pressed", String(p.atLiveEdge && !p.isPaused));
    const speed = String(p.speed);
    if (this.speedSelect.value !== speed) this.speedSelect.value = speed;
    this.hudText.textContent = `${this.fps.toFixed(0)} fps · ${s.info.tps * p.speed} tps`;
  }

  private updatePanels(): void {
    const snap = this.playback.current();
    const lives = this.source.lives();
    // Rebuild only when something visible changed.
    const key = `${snap?.tick}|${this.selectedId}|${lives.length}|${this.source.firstTick}|${this.source.lastTick}`;
    if (key === this.panelKey) return;
    this.panelKey = key;
    this.renderList(snap);
    this.renderPanel(snap);
    this.syncMarkers();
  }

  private renderList(snap: TickSnapshot | undefined): void {
    const rows: HTMLElement[] = [h("h3", {}, `Snakes · ${snap?.snakes.length ?? 0} alive`)];
    for (const s of ranking(snap)) {
      const life = this.source.life(s.id);
      rows.push(
        this.row(s.id, life?.color ?? "#888", fmt.score(s.score), `${fmt.mass(s.mass)} len`, false),
      );
    }
    const deaths = recentDeaths(this.source, snap?.tick ?? 0, DEATHS_LISTED);
    if (deaths.length > 0) rows.push(h("div", { class: "zsv-sub" }, "Recent deaths"));
    for (const life of deaths) {
      const d = life.death;
      if (!d) continue;
      rows.push(this.row(life.id, life.color, fmt.score(d.score), `t${d.tick}`, true));
    }
    this.list.replaceChildren(...rows);
  }

  private row(id: string, color: string, score: string, extra: string, dead: boolean): HTMLElement {
    // No listener here: rows are rebuilt every tick, see the delegation in `bindEvents`.
    return h(
      "button",
      {
        type: "button",
        class: dead ? "zsv-row zsv-dead" : "zsv-row",
        "aria-selected": String(id === this.selectedId),
        "data-id": id,
      },
      swatch(color),
      h("span", { class: "zsv-name" }, id),
      h("span", { class: "zsv-num" }, score),
      h("span", { class: "zsv-num zsv-mass" }, extra),
    );
  }

  private renderPanel(snap: TickSnapshot | undefined): void {
    const id = this.selectedId;
    const { empty, info, buttons, deathBtn, logSection, logBox } = this.panelParts;
    empty.hidden = id !== undefined;
    buttons.hidden = id === undefined;
    logSection.hidden = id === undefined;
    if (id === undefined) {
      info.replaceChildren();
      return;
    }
    const state = lifeAt(this.source, id, snap);
    const life = state.kind === "unknown" ? this.source.life(id) : state.life;
    const header = h(
      "div",
      { class: "zsv-head" },
      swatch(life?.color ?? "#888"),
      h("span", { class: "zsv-title zsv-name" }, id),
      life && life.author !== life.bot && h("span", { class: "zsv-empty" }, `by ${life.author}`),
    );

    let status: HTMLElement;
    let stats: HTMLElement | undefined;
    let action: HTMLElement | undefined;
    if (state.kind === "alive") {
      const s = state.snake;
      status = h("div", { class: "zsv-status" }, `alive · life tick ${s.lifeTick}`);
      stats = statsGrid([
        ["score", fmt.score(s.score)],
        ["length", fmt.mass(s.mass)],
        ["segments", String(s.segments)],
        ["kills", String(s.kills)],
      ]);
      action = actionView(s.action);
    } else if (state.kind === "dead") {
      const d = state.life.death;
      status = h(
        "div",
        { class: "zsv-status zsv-is-dead" },
        d ? deathText(d, this.source) : "dead",
      );
      if (d) {
        stats = statsGrid([
          ["score", fmt.score(d.score)],
          ["length", fmt.mass(d.mass)],
          ["kills", String(d.kills)],
          ["lived", `${d.tick - state.life.bornTick} ticks`],
        ]);
      }
    } else if (state.kind === "unborn") {
      status = h("div", { class: "zsv-status" }, `spawns at tick ${state.life.bornTick}`);
    } else {
      status = h("div", { class: "zsv-status" }, "not in this tick");
    }
    info.replaceChildren(header, status, ...(stats ? [stats] : []), ...(action ? [action] : []));
    deathBtn.disabled = !life?.death;

    const logs = recentLogs(this.source, id, snap?.tick ?? this.source.lastTick);
    const lines: HTMLElement[] = [];
    if (logs.length === 0) lines.push(h("span", { class: "zsv-empty" }, "No log() output yet."));
    for (const entry of logs) {
      const now = entry.tick === snap?.tick;
      for (const line of entry.lines) {
        lines.push(
          h(
            "div",
            { class: now ? "zsv-log zsv-now" : "zsv-log" },
            h("span", { class: "zsv-log-tick" }, String(entry.tick)),
            line,
          ),
        );
      }
      if (entry.truncated) lines.push(h("div", { class: "zsv-log" }, "… truncated"));
    }
    logBox.replaceChildren(...lines);
    logBox.scrollTop = logBox.scrollHeight;
  }

  /**
   * Death markers are kept, not rebuilt: each one is placed by its tick in CSS, so only the
   * container's range changes as the match grows, and only new or evicted deaths touch the DOM.
   */
  private syncMarkers(): void {
    const s = this.source;
    const first = s.firstTick;
    const span = Math.max(1, (s.endTick ?? s.lastTick) - first);
    const style = this.markers.style;
    if (style.getPropertyValue("--first") !== String(first))
      style.setProperty("--first", String(first));
    if (style.getPropertyValue("--span") !== String(span))
      style.setProperty("--span", String(span));

    for (const life of s.lives()) {
      const d = life.death;
      if (!d || this.deathMarks.has(life.id)) continue;
      const el = h("div", { class: "zsv-marker", title: `${life.id} died (tick ${d.tick})` });
      el.style.setProperty("--t", String(d.tick));
      this.deathMarks.set(life.id, { el, tick: d.tick });
      this.markers.append(el);
    }
    for (const [id, mark] of this.deathMarks) {
      if (mark.tick >= first) continue;
      mark.el.remove();
      this.deathMarks.delete(id);
    }

    if (this.markedId !== this.selectedId) {
      if (this.markedId !== undefined)
        this.deathMarks.get(this.markedId)?.el.classList.remove("zsv-mine");
      this.markedId = this.selectedId;
    }
    const id = this.selectedId;
    if (id !== undefined) this.deathMarks.get(id)?.el.classList.add("zsv-mine");
    const born = id === undefined ? undefined : s.life(id)?.bornTick;
    this.bornMark.hidden = born === undefined || born <= first;
    if (born !== undefined) this.bornMark.style.setProperty("--t", String(born));
  }

  private jumpToDeath(): void {
    if (this.selectedId !== undefined) this.playback.jumpToDeath(this.selectedId);
  }

  /** Selects the next (or previous) living snake by score. */
  private cycle(direction: 1 | -1): void {
    const ids = ranking(this.playback.current()).map((s) => s.id);
    if (ids.length === 0) return;
    const at = this.selectedId === undefined ? -1 : ids.indexOf(this.selectedId);
    const next =
      at < 0 ? (direction > 0 ? 0 : ids.length - 1) : (at + direction + ids.length) % ids.length;
    this.select(ids[next]);
  }

  private bindEvents(keyboard: "focus" | "window" | "off"): void {
    const listen = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Window,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };

    // Scrubbing: hold the clock while dragging, resume afterwards.
    listen(this.range, "pointerdown", () => {
      this.scrubbing = { wasPaused: this.playback.isPaused };
    });
    listen(this.range, "input", () => this.playback.seek(Number(this.range.value)));
    const endScrub = () => {
      if (!this.scrubbing) return;
      if (this.scrubbing.wasPaused) this.playback.pause();
      this.scrubbing = undefined;
    };
    listen(this.range, "pointerup", endScrub);
    listen(this.range, "pointercancel", endScrub);
    listen(this.range, "change", endScrub);

    // Snake list: select on press, since rows are replaced every tick and a click whose press
    // and release land on different rows never fires. Keyboard activation still clicks.
    const rowId = (e: Event) =>
      (e.target as HTMLElement).closest<HTMLElement>(".zsv-row")?.dataset.id;
    const toggle = (id: string) => this.select(id === this.selectedId ? undefined : id);
    listen(this.list, "pointerdown", (e) => {
      const id = rowId(e);
      if (e.button === 0 && id !== undefined) toggle(id);
    });
    listen(this.list, "click", (e) => {
      const id = rowId(e);
      if (e.detail === 0 && id !== undefined) toggle(id);
    });

    // Click on the arena to select a snake.
    let down: { x: number; y: number } | undefined;
    listen(this.stage, "pointerdown", (e) => {
      down = { x: e.clientX, y: e.clientY };
    });
    listen(this.stage, "pointerup", (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      if ((e.target as HTMLElement).closest(".zsv-hud")) return;
      const at = this.renderer.screenToWorld(e.clientX, e.clientY);
      const id = pickSnake(this.playback.sample()?.next ?? this.playback.current(), at, 2.5);
      if (id !== undefined) this.select(id);
    });
    listen(
      this.stage,
      "wheel",
      (e) => {
        e.preventDefault();
        this.renderer.setZoom(this.renderer.getZoom() * Math.exp(-e.deltaY * 0.001));
      },
      { passive: false },
    );
    listen(this.element, "pointerdown", () => {
      if (keyboard === "focus") this.element.focus({ preventScroll: true });
    });

    if (keyboard === "off") return;
    const target = keyboard === "window" ? window : this.element;
    listen(target as HTMLElement, "keydown", (e) => {
      const el = e.target as HTMLElement | null;
      if (
        el &&
        el !== this.element &&
        /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) &&
        el !== this.range
      ) {
        return;
      }
      if (this.handleKey(e)) e.preventDefault();
    });
  }

  private handleKey(e: KeyboardEvent): boolean {
    const p = this.playback;
    const big = e.shiftKey ? 10 : 1;
    switch (e.key) {
      case " ":
        p.toggle();
        return true;
      case "ArrowLeft":
        p.stepBy(-big);
        return true;
      case "ArrowRight":
        p.stepBy(big);
        return true;
      case "[":
        p.stepSpeed(-1);
        return true;
      case "]":
        p.stepSpeed(1);
        return true;
      case "l":
        p.goLive();
        return true;
      case "d":
        this.jumpToDeath();
        return true;
      case "o":
        this.setFollow(false);
        return true;
      case "f":
        this.setFollow(true);
        return true;
      case "v":
        this.showVision = !this.showVision;
        this.applyCamera();
        return true;
      case "Tab":
        this.cycle(e.shiftKey ? -1 : 1);
        return true;
      case "Escape":
        this.select(undefined);
        return true;
      case "+":
      case "=":
        this.renderer.setZoom(this.renderer.getZoom() * 1.25);
        return true;
      case "-":
        this.renderer.setZoom(this.renderer.getZoom() / 1.25);
        return true;
      default:
        return false;
    }
  }
}

function statsGrid(items: readonly [string, string][]): HTMLElement {
  const dl = h("dl", { class: "zsv-stats" });
  for (const [k, v] of items) dl.append(h("dt", {}, k), h("dd", {}, v));
  return dl;
}

function actionView(action: { turn: number; boost?: boolean } | undefined): HTMLElement {
  const wrap = h("div", { class: "zsv-section", style: "padding: 8px 0 0; border: 0" });
  wrap.append(h("h3", {}, "Action this tick"));
  if (!action) {
    wrap.append(h("div", { class: "zsv-empty" }, "not decided yet"));
    return wrap;
  }
  const turn = Math.max(-1, Math.min(1, Number(action.turn) || 0));
  const fill = h("div", { class: "zsv-turnfill" });
  // Positive turn is right (clockwise): draw it to the right of centre.
  fill.style.left = `${50 + Math.min(0, turn) * 50}%`;
  fill.style.width = `${Math.abs(turn) * 50}%`;
  wrap.append(
    h(
      "div",
      { class: "zsv-turn" },
      h("span", {}, `turn ${fmt.turn(turn)}`),
      h("div", { class: "zsv-turnbar" }, fill),
      action.boost
        ? h("span", { class: "zsv-boost" }, "BOOST")
        : h("span", { class: "zsv-empty" }, "no boost"),
    ),
  );
  return wrap;
}

function deathText(d: NonNullable<LifeInfo["death"]>, source: MatchSource): string {
  const killer = d.killerId ? ` by ${source.life(d.killerId)?.id ?? d.killerId}` : "";
  return `died on tick ${d.tick}: ${d.cause}${killer}`;
}
