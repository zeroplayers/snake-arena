/**
 * Spectators of a room (#27, SPEC §4 showcase rooms): WebSockets on the Hibernation API that get
 * the room's ticks as broadcast messages (`@zerosnake/engine` `broadcast.ts`).
 *
 * - **Real time while watched.** A room runs in real time while it has spectators, and for
 *   `spectatorGraceMs` after the last one left (a reload or a flaky network doesn't flip it to
 *   accelerated and back); `RoomDO` asks `wantsRealtime`.
 * - **Deltas from committed batches.** The encoder sees every tick of a batch (`afterStep`), but
 *   the deltas go out only once the batch is saved: a batch that dies is re-run from the saved
 *   frame by restarted bots, so its ticks may never happen. A failed batch drops the encoder; the
 *   next one starts a new stream and everyone gets a keyframe.
 * - **One message per batch.** Real time runs `REALTIME_BATCH_TICKS` ticks per second, so a
 *   spectator gets a second of ticks at once and plays them behind the live edge (the viewer's
 *   `BroadcastSource`). Each message is encoded once and the same bytes go to every socket.
 * - **Backpressure.** Server-side WebSockets don't expose `bufferedAmount`, so spectators ack the
 *   ticks they've applied. One more than `MAX_UNACKED_TICKS` behind is skipped (nothing is
 *   queued for it); once it has caught up it gets a keyframe, i.e. it skips to the latest tick.
 *   Sending never waits, so a slow spectator can't slow the simulation.
 * - **Joining.** A new spectator gets a keyframe at once if no batch is running, else after the
 *   batch. Socket state lives in memory; after hibernation every socket simply gets a keyframe.
 * - **Limits.** A room takes `MAX_SPECTATORS`, and `MAX_SPECTATORS_PER_CLIENT` from one client
 *   (the showcase route's `SPECTATOR_CLIENT_HEADER`: a hash of the visitor's IP, kept as the
 *   socket's tag, so it survives hibernation). A socket that leaves ticks unacked for
 *   `ACK_TIMEOUT_MS` is closed (4002): holding one without watching costs nothing otherwise, as
 *   pings are answered without waking the room. When the room leaves the showcase (`release`), everyone
 *   is closed (4000) and the room goes back to its own pace at once.
 * - **Public labels only.** Spectators see a life as its owner's username, the bot's slug and
 *   the version's number (`BroadcastLabel`), looked up in D1 once per version (`prepare`) and
 *   cached; never life, user, version or room ids.
 */
import {
  BroadcastEncoder,
  type BroadcastLabel,
  encodeBroadcast,
  type TickDelta,
  type World,
} from "@zerosnake/engine";

/** How long a room stays in real time after its last spectator left. */
export const SPECTATOR_GRACE_MS = 30_000;
/** Spectators one room accepts. */
export const MAX_SPECTATORS = 500;
/** Spectators one room accepts from one client (several tabs, or people behind one NAT). */
export const MAX_SPECTATORS_PER_CLIENT = 6;
/** A spectator that leaves ticks unacked this long is closed (it acks every message it applies). */
export const ACK_TIMEOUT_MS = 30_000;
/**
 * Request header with the spectator's client key (set by the showcase route, `showcase.ts`, from
 * what the site's proxy says). Without it, only `MAX_SPECTATORS` applies (tests, tools).
 */
export const SPECTATOR_CLIENT_HEADER = "x-spectator-client";
/** Labels cached per room; more than this and the cache starts over. */
const MAX_LABELS = 1000;
/** Ticks a spectator may lag in acks before it's skipped (5 s of real time). */
export const MAX_UNACKED_TICKS = 50;
/**
 * A batch with more ticks than this (one planned before the room went real time) is sent as a
 * keyframe: spectators skip it instead of replaying it.
 */
export const MAX_TICKS_PER_MESSAGE = 30;
/** Largest message sent; a bigger delta is replaced by a keyframe, a bigger keyframe skipped. */
export const MAX_MESSAGE_BYTES = 512 * 1024;
/** Longest message a spectator may send (`{"ack":<tick>}`). */
const MAX_CLIENT_MESSAGE = 64;

/** What a spectator was sent last and has acked (-1: nothing yet). */
interface SocketState {
  stream: number;
  lastTick: number;
  acked: number;
  /** Wall ms since when ticks it was sent wait for its ack; null while it has acked them all. */
  waitingSince: number | null;
}

/** A life as the room knows it, enough to label it. */
export interface SpectatedLife {
  /** Null for a house bot. */
  versionId: string | null;
  /** House bot kind, null for a deployed version. */
  house: string | null;
}

/** What spectators need from their room. */
export interface SpectatedRoom {
  readonly roomId: string;
  /** The saved world while no batch is running, else null (the keyframe waits for the batch). */
  idleWorld(): World | null;
  /** A life of the room (running or about to spawn). */
  life(lifeId: string): SpectatedLife | null;
  /** Versions of the room's lives, running or about to spawn. */
  versionIds(): string[];
}

/** Public labels of versions by version id (missing ones simply aren't returned). */
export type LabelLookup = (versionIds: string[]) => Promise<Map<string, BroadcastLabel>>;

/** Shown for a deployed version whose label couldn't be read. */
const UNKNOWN: BroadcastLabel = { author: "", bot: "", version: 0, house: false };

export class Spectators {
  private encoder: BroadcastEncoder | null = null;
  private pending: TickDelta[] = [];
  private readonly state = new WeakMap<WebSocket, SocketState>();
  /** Wall ms when the room last had a spectator (in memory: a restart forgets the grace). */
  private seenAt = 0;
  private readonly labels = new Map<string, BroadcastLabel>();
  /** Sockets the room closed (released, silent): their leaving starts no grace period. */
  private readonly dismissed = new WeakSet<WebSocket>();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly room: () => SpectatedRoom | null,
    private readonly lookup: LabelLookup,
  ) {
    // Keepalives answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** Open spectator sockets. */
  get count(): number {
    return this.open().length;
  }

  /** Whether the room should run in real time: watched now, or within the grace period. */
  wantsRealtime(now: number, graceMs = SPECTATOR_GRACE_MS): boolean {
    if (this.count > 0) {
      this.seenAt = now;
      return true;
    }
    return now - this.seenAt < graceMs;
  }

  /** Upgrades a spectator's request; its keyframe follows. */
  async accept(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    if (!this.room()) return new Response("Room closed", { status: 410 });
    if (this.count >= MAX_SPECTATORS) return new Response("Too many spectators", { status: 503 });
    const key = request.headers.get(SPECTATOR_CLIENT_HEADER);
    const tag = key ? `client:${key.slice(0, 64)}` : null;
    if (tag && this.open(tag).length >= MAX_SPECTATORS_PER_CLIENT) {
      return new Response("Too many spectators from this client", { status: 429 });
    }
    // The first spectator's labels; later ones mostly find them cached.
    await this.prepare(true);
    const room = this.room();
    if (!room) return new Response("Room closed", { status: 410 });
    // Again after the await: a burst of upgrades all passed the checks above while the lookup ran.
    if (this.count >= MAX_SPECTATORS) return new Response("Too many spectators", { status: 503 });
    if (tag && this.open(tag).length >= MAX_SPECTATORS_PER_CLIENT) {
      return new Response("Too many spectators from this client", { status: 429 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, tag ? [tag] : []);
    this.state.set(server, fresh());
    this.seenAt = Date.now();
    const world = room.idleWorld();
    if (world) this.send(room, world, [], [server]);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Looks up the labels of the room's versions not cached yet, while anyone watches (or `force`).
   * Before a batch, so its spawns are labelled; a failed lookup is retried next time, and the
   * lives meanwhile go out as `UNKNOWN`.
   */
  async prepare(force = false): Promise<void> {
    const room = this.room();
    if (!room || (!force && this.count === 0)) return;
    const missing = [...new Set(room.versionIds())].filter((id) => !this.labels.has(id));
    if (missing.length === 0) return;
    try {
      const found = await this.lookup(missing);
      if (this.labels.size + missing.length > MAX_LABELS) this.labels.clear();
      // Versions D1 doesn't know stay `UNKNOWN` instead of being looked up again on every upgrade.
      for (const id of missing) this.labels.set(id, found.get(id) ?? UNKNOWN);
    } catch (e) {
      console.error("spectators: label lookup failed", room.roomId, e);
    }
  }

  /** The room left the showcase: spectators go and find the new one, and the grace ends now. */
  release(reason: string): void {
    this.closeAll(reason);
    this.seenAt = 0;
  }

  /**
   * Before a batch runs on `world` (the saved frame): returns what to call after each step, or
   * undefined while nobody watches (then nothing is encoded).
   */
  beginBatch(world: World): ((world: World) => void) | undefined {
    this.pending = [];
    const room = this.room();
    if (!room || this.count === 0) {
      this.encoder = null;
      return undefined;
    }
    const encoder = this.encoderAt(room, world);
    return (w) => this.pending.push(encoder.step(w));
  }

  /**
   * The batch was saved with `world` as its last frame: close sockets that left what they were
   * sent unacked for `ackTimeoutMs`, and send its ticks to the rest.
   */
  commit(world: World, ackTimeoutMs = ACK_TIMEOUT_MS): void {
    const ticks = this.pending;
    this.pending = [];
    this.closeSilent(Date.now(), ackTimeoutMs);
    const room = this.room();
    // Unwatched at the start of the batch: only those who joined during it, with keyframes.
    if (room) this.send(room, world, this.encoder ? ticks : [], this.open());
  }

  /** The batch failed: its ticks never happened. Spectators get a new stream. */
  abort(): void {
    this.pending = [];
    this.encoder = null;
  }

  /** The room closed: spectators go and find another one. */
  closeAll(reason: string): void {
    for (const ws of this.open()) this.dismiss(ws, 4000, reason);
    this.encoder = null;
  }

  message(ws: WebSocket, message: string | ArrayBuffer): void {
    let ack: unknown;
    try {
      if (typeof message !== "string" || message.length > MAX_CLIENT_MESSAGE) throw new Error();
      ack = (JSON.parse(message) as { ack?: unknown }).ack;
      if (!Number.isInteger(ack)) throw new Error();
    } catch {
      ws.close(1008, 'expected {"ack":<tick>}');
      return;
    }
    const s = this.socket(ws);
    // Acks past what was sent don't count: a client can't talk its way out of being skipped.
    s.acked = Math.max(s.acked, Math.min(ack as number, s.lastTick));
    s.waitingSince = s.acked >= s.lastTick ? null : Date.now();
  }

  closed(ws: WebSocket, code: number, reason: string): void {
    if (!this.dismissed.has(ws)) this.seenAt = Date.now();
    this.state.delete(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {}
  }

  /**
   * Sends `ticks` (ending at `world`'s frame) to whoever is caught up, and a keyframe of `world`
   * to anyone joining, off the stream, or back from being skipped.
   */
  private send(room: SpectatedRoom, world: World, ticks: TickDelta[], sockets: WebSocket[]): void {
    if (sockets.length === 0) return;
    const encoder = this.encoderAt(room, world, ticks.length > 0);
    const from = ticks[0]?.tick ?? world.tick + 1;
    let delta: Uint8Array | null = null;
    if (ticks.length > 0 && ticks.length <= MAX_TICKS_PER_MESSAGE) {
      delta = encodeBroadcast({ kind: "ticks", stream: encoder.stream, ticks });
      if (delta.length > MAX_MESSAGE_BYTES) {
        console.warn("spectators: delta too big, sending keyframes", room.roomId, delta.length);
        delta = null;
      }
    }
    let keyframe: Uint8Array | null | undefined;
    const now = Date.now();
    for (const ws of sockets) {
      const s = this.socket(ws);
      if (s.stream === encoder.stream && s.lastTick === world.tick) continue;
      if (s.lastTick - s.acked > MAX_UNACKED_TICKS) continue;
      let bytes: Uint8Array | null;
      if (delta && s.stream === encoder.stream && s.lastTick === from - 1) {
        bytes = delta;
      } else {
        keyframe ??= this.keyframe(room, encoder, world);
        bytes = keyframe;
        // A fresh window: it hasn't had the chance to ack anything of this yet.
        s.acked = world.tick;
      }
      if (!bytes) continue;
      try {
        ws.send(bytes);
      } catch {
        // Closing; `webSocketClose` cleans up.
        continue;
      }
      s.stream = encoder.stream;
      s.lastTick = world.tick;
      if (s.lastTick > s.acked) s.waitingSince ??= now;
    }
  }

  private closeSilent(now: number, timeoutMs: number): void {
    for (const ws of this.open()) {
      const since = this.socket(ws).waitingSince;
      if (since !== null && now - since > timeoutMs) this.dismiss(ws, 4002, "no acks");
    }
  }

  private dismiss(ws: WebSocket, code: number, reason: string): void {
    this.dismissed.add(ws);
    try {
      ws.close(code, reason);
    } catch {}
  }

  private keyframe(
    room: SpectatedRoom,
    encoder: BroadcastEncoder,
    world: World,
  ): Uint8Array | null {
    const bytes = encodeBroadcast(encoder.keyframe(world));
    if (bytes.length <= MAX_MESSAGE_BYTES) return bytes;
    console.error("spectators: keyframe too big", room.roomId, bytes.length);
    return null;
  }

  /**
   * The encoder, at `world`'s frame. One that is somewhere else (ticks ran unwatched) is
   * replaced by a new stream. After a batch (`stepped`) it is already there.
   */
  private encoderAt(room: SpectatedRoom, world: World, stepped = false): BroadcastEncoder {
    if (this.encoder && (stepped || this.encoder.tick === world.tick)) return this.encoder;
    this.encoder = new BroadcastEncoder(world, {
      stream: crypto.getRandomValues(new Uint32Array(1))[0] ?? 0,
      label: (id) => this.label(room, id),
    });
    return this.encoder;
  }

  private label(room: SpectatedRoom, lifeId: string): BroadcastLabel {
    const life = room.life(lifeId);
    if (!life) return UNKNOWN;
    if (life.versionId === null) {
      return { author: "house", bot: life.house ?? "house", version: 0, house: true };
    }
    return this.labels.get(life.versionId) ?? UNKNOWN;
  }

  private socket(ws: WebSocket): SocketState {
    let s = this.state.get(ws);
    if (!s) {
      // Back from hibernation: as if it just joined.
      s = fresh();
      this.state.set(ws, s);
    }
    return s;
  }

  private open(tag?: string): WebSocket[] {
    return this.ctx.getWebSockets(tag).filter((ws) => ws.readyState === WebSocket.OPEN);
  }
}

function fresh(): SocketState {
  return { stream: -1, lastTick: -1, acked: -1, waitingSince: null };
}

/** `LabelLookup` from D1: the owner's username, the bot's slug and the version's number. */
export function labelsFromD1(db: D1Database): LabelLookup {
  return async (versionIds) => {
    const labels = new Map<string, BroadcastLabel>();
    for (let i = 0; i < versionIds.length; i += 50) {
      const ids = versionIds.slice(i, i + 50);
      const { results } = await db
        .prepare(
          `SELECT v.id, v.n, b.slug, u.username FROM versions v
           JOIN bots b ON b.id = v.bot_id JOIN users u ON u.id = b.owner_id
           WHERE v.id IN (${ids.map(() => "?").join(", ")})`,
        )
        .bind(...ids)
        .all<{ id: string; n: number; slug: string; username: string | null }>();
      for (const r of results) {
        labels.set(r.id, { author: r.username ?? "", bot: r.slug, version: r.n, house: false });
      }
    }
    return labels;
  };
}
