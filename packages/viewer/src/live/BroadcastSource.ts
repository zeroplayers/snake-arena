import {
  BroadcastGapError,
  type BroadcastMessage,
  BroadcastView,
  DEFAULT_CONFIG,
  decodeBroadcast,
  type Keyframe,
  TICK_RATE,
} from "@zerosnake/engine";
import { type RenderFood, type RenderSnake, SNAKE_PALETTE } from "@zerosnake/renderer";
import type { Playback } from "../Playback.ts";
import type { LifeInfo, MatchInfo, MatchSource, SnakeTick, TickSnapshot } from "../types.ts";
import { DEFAULT_VISION_RADIUS } from "./LiveEngineSource.ts";

/**
 * Default ticks a broadcast is watched behind its newest one. Rooms send a second of ticks at
 * once (one batch), so this is a second and a half: a burst arrives before the playhead needs it.
 */
export const DEFAULT_LIVE_DELAY = 15;

export interface BroadcastSourceOptions {
  /** Opens a socket to the broadcast, e.g. `() => new WebSocket(url)`; called again to reconnect. */
  readonly connect: () => WebSocket;
  readonly title?: string;
  /** Ticks kept for the playhead to read; older ones are dropped. Default 600 (a minute). */
  readonly maxTicks?: number;
  /** `MatchInfo.liveDelay`. Default `DEFAULT_LIVE_DELAY`. */
  readonly liveDelay?: number;
  /** First wait before reconnecting, doubled up to `maxRetryMs`. Default 1 s. */
  readonly retryMs?: number;
  /** Default 15 s. */
  readonly maxRetryMs?: number;
  /** Keepalive ping interval (the room answers without waking up). Default 30 s. */
  readonly pingMs?: number;
}

export type BroadcastStatus = "connecting" | "live" | "reconnecting" | "closed";

type MutableLife = { -readonly [K in keyof LifeInfo]: LifeInfo[K] };

/**
 * A room's live broadcast (`@zerosnake/engine` `broadcast.ts`, served by the arena's showcase) as
 * a `MatchSource`. Ticks arrive a batch (about a second) at a time; `lastTick` grows as they do,
 * `request` is a no-op, and the playhead is kept `info.liveDelay` ticks behind the newest one by
 * `followLive`, so playback stays smooth and interpolated between bursts.
 *
 * Reconnects by itself (with backoff) when the socket drops; the room sends a keyframe on every
 * connection. A keyframe that doesn't continue the ticks it has (another stream: the room
 * restarted, or the showcase moved to another room) starts the history over from it. It acks every
 * message it applied: a spectator that stops acking is skipped by the room until it catches up,
 * then gets the newest keyframe (`apps/arena/src/room/spectators.ts`).
 */
export class BroadcastSource implements MatchSource {
  readonly endTick = undefined;
  status: BroadcastStatus = "connecting";

  private infoValue: MatchInfo;
  private readonly view = new BroadcastView();
  private readonly snapshots = new Map<number, TickSnapshot>();
  private first = 0;
  private last = -1;
  private readonly lifeList: MutableLife[] = [];
  private readonly lifeById = new Map<string, MutableLife>();
  /** Life id by slot, for the current stream (deaths name their killer by slot). */
  private readonly slotIds = new Map<number, string>();
  private readonly foodCache = new Map<number, RenderFood>();
  private socket: WebSocket | null = null;
  private retryMs: number;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  private readyResolve: (() => void) | undefined;
  private readyReject: ((e: Error) => void) | undefined;
  /** Settles on the first keyframe, or rejects if the first connection fails before one. */
  readonly ready: Promise<void>;

  constructor(private readonly options: BroadcastSourceOptions) {
    this.retryMs = options.retryMs ?? 1000;
    this.infoValue = this.makeInfo(null);
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // Nobody may be waiting on `ready`.
    this.ready.catch(() => {});
    this.open();
  }

  /** Connects and waits for the first keyframe; rejects (and disposes) after `timeoutMs`. */
  static async open(
    options: BroadcastSourceOptions & { timeoutMs?: number },
  ): Promise<BroadcastSource> {
    const source = new BroadcastSource(options);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("no broadcast within the timeout")),
        options.timeoutMs ?? 5000,
      );
    });
    try {
      await Promise.race([source.ready, timeout]);
      return source;
    } catch (e) {
      source.dispose();
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  get info(): MatchInfo {
    return this.infoValue;
  }

  get firstTick(): number {
    return this.first;
  }

  get lastTick(): number {
    return Math.max(this.first, this.last);
  }

  request(): void {}

  snapshot(tick: number): TickSnapshot | undefined {
    return this.snapshots.get(tick);
  }

  lives(): readonly LifeInfo[] {
    return this.lifeList;
  }

  life(id: string): LifeInfo | undefined {
    return this.lifeById.get(id);
  }

  dispose(): void {
    this.disposed = true;
    this.status = "closed";
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    const ws = this.socket;
    this.socket = null;
    try {
      ws?.close(1000, "bye");
    } catch {}
    this.readyReject?.(new Error("disposed"));
  }

  /** Applies one message from the room (exposed for tests; the socket calls it). */
  receive(message: BroadcastMessage): void {
    if (message.kind === "keyframe") {
      this.keyframe(message);
    } else {
      for (const t of message.ticks) {
        this.view.applyTick(message.stream, t);
        this.record();
      }
    }
  }

  private open(): void {
    if (this.disposed) return;
    let ws: WebSocket;
    try {
      ws = this.options.connect();
    } catch (e) {
      this.dropped(e);
      return;
    }
    this.socket = ws;
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (e) => {
      if (this.socket !== ws || typeof e.data === "string") return; // "pong"
      try {
        this.receive(decodeBroadcast(new Uint8Array(e.data as ArrayBuffer)));
        ws.send(JSON.stringify({ ack: this.view.tick }));
      } catch (error) {
        // A gap or a message we can't read: start over from a fresh keyframe.
        if (!(error instanceof BroadcastGapError)) console.warn("broadcast:", error);
        this.dropped(error);
        ws.close(4001, "resync");
      }
    });
    const onEnd = (e: Event) => {
      if (this.socket === ws) this.dropped(e);
    };
    ws.addEventListener("close", onEnd);
    ws.addEventListener("error", onEnd);
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      try {
        if (ws.readyState === 1) ws.send("ping");
      } catch {}
    }, this.options.pingMs ?? 30_000);
  }

  private dropped(reason: unknown): void {
    this.socket = null;
    clearInterval(this.pingTimer);
    if (this.disposed) return;
    if (this.status === "connecting") {
      // Never got a keyframe: whoever waits on `ready` decides whether to keep trying.
      this.readyReject?.(reason instanceof Error ? reason : new Error("broadcast unavailable"));
    }
    this.status = this.status === "connecting" ? "connecting" : "reconnecting";
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.open(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, this.options.maxRetryMs ?? 15_000);
  }

  private keyframe(k: Keyframe): void {
    const continues = this.view.stream === k.stream && this.view.tick === k.tick && this.last >= 0;
    this.view.applyKeyframe(k);
    this.retryMs = this.options.retryMs ?? 1000;
    this.status = "live";
    this.infoValue = this.makeInfo(k);
    if (!continues) {
      this.snapshots.clear();
      this.slotIds.clear();
      this.first = k.tick;
      this.last = k.tick - 1;
      this.record();
    }
    this.readyResolve?.();
  }

  /** Turns the view's current tick into a snapshot. */
  private record(): void {
    const view = this.view;
    const config = view.config ?? DEFAULT_CONFIG;
    const tick = view.tick;
    const snakes: SnakeTick[] = [];
    const renderSnakes: RenderSnake[] = [];
    for (const { life: l, snake } of view.snakes) {
      this.slotIds.set(l.slot, l.id);
      const life = this.lifeOf(l.id, l.bot, l.author, l.bornTick);
      snakes.push({
        id: snake.id,
        score: snake.score,
        mass: snake.mass,
        segments: snake.segments.length,
        kills: snake.kills,
        lifeTick: snake.lifeTick,
        boosting: snake.boosting,
      });
      renderSnakes.push({
        id: snake.id,
        segments: snake.segments.map((p) => ({ x: p.x, y: p.y })),
        angle: snake.angle,
        length: snake.mass,
        radius: snake.size / 2,
        skin: { color: life.color },
      });
    }
    const deaths: string[] = [];
    for (const d of view.deaths) {
      deaths.push(d.life.id);
      const life = this.lifeOf(d.life.id, d.life.bot, d.life.author, d.life.bornTick);
      life.death = {
        tick,
        cause: d.cause,
        killerId: d.killerSlot === null ? null : (this.slotIds.get(d.killerSlot) ?? null),
        score: d.score,
        mass: d.mass,
        kills: d.kills,
      };
    }
    for (const d of view.deaths) this.slotIds.delete(d.slot);
    const food: RenderFood[] = [];
    for (const f of view.food.values()) {
      let r = this.foodCache.get(f.id);
      if (!r) {
        r = {
          id: f.id,
          x: f.x,
          y: f.y,
          size: f.kind === "remains" ? config.remainsRadius : config.foodRadius,
        };
        this.foodCache.set(f.id, r);
      }
      food.push(r);
    }
    if (this.foodCache.size > 4 * Math.max(64, view.food.size)) {
      for (const id of this.foodCache.keys()) if (!view.food.has(id)) this.foodCache.delete(id);
    }
    this.snapshots.set(tick, {
      tick,
      frame: { tick, arenaRadius: config.arenaRadius, snakes: renderSnakes, food },
      snakes,
      deaths,
    });
    this.last = tick;
    const maxTicks = Math.max(2, this.options.maxTicks ?? 600);
    while (this.last - this.first >= maxTicks) this.snapshots.delete(this.first++);
  }

  private lifeOf(id: string, bot: string, author: string, bornTick: number): MutableLife {
    let life = this.lifeById.get(id);
    if (!life) {
      const color = SNAKE_PALETTE[this.lifeList.length % SNAKE_PALETTE.length] as string;
      life = { id, bot, author, color, bornTick };
      this.lifeList.push(life);
      this.lifeById.set(id, life);
      // Keep the list to lives the history can still show, plus some.
      if (this.lifeList.length > 1000) {
        const old = this.lifeList.splice(0, this.lifeList.length - 1000);
        for (const o of old) this.lifeById.delete(o.id);
      }
    }
    return life;
  }

  private makeInfo(k: Keyframe | null): MatchInfo {
    const config = k?.config ?? DEFAULT_CONFIG;
    const vision = (config as { visionRadius?: number }).visionRadius;
    return {
      tps: TICK_RATE,
      arenaRadius: config.arenaRadius,
      visionRadius: vision ?? DEFAULT_VISION_RADIUS,
      liveDelay: this.options.liveDelay ?? DEFAULT_LIVE_DELAY,
      ...((this.options.title ?? k?.room) !== undefined && {
        title: this.options.title ?? (k?.room as string),
      }),
    };
  }
}

/**
 * Keeps a playhead about `info.liveDelay` ticks behind a live broadcast's newest tick: a little
 * slower when it gets close (so it doesn't stall at the edge between bursts), a little faster when
 * it falls behind, and straight to the latest when far behind (a background tab, a keyframe after
 * being skipped). Sources without `liveDelay` (a local engine, a replay) are left alone.
 */
export function followLive(playback: Playback): void {
  const s = playback.source;
  const delay = s.info.liveDelay;
  if (delay === undefined || s.endTick !== undefined || playback.isPaused) return;
  const lag = s.lastTick - playback.position;
  if (lag > 3 * delay) {
    playback.seek(Math.max(s.firstTick, s.lastTick - delay));
    playback.setSpeed(1);
    return;
  }
  playback.setSpeed(lag > 2 * delay ? 1.25 : lag < delay / 2 ? 0.8 : 1);
}
