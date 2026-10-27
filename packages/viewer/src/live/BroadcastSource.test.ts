import {
  BroadcastEncoder,
  type BroadcastMessage,
  createWorld,
  encodeBroadcast,
  spawnSnake,
  step,
  type TickDelta,
  type World,
} from "@zerosnake/engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Playback } from "../Playback.ts";
import { BroadcastSource, DEFAULT_LIVE_DELAY, followLive } from "./BroadcastSource.ts";

/** A WebSocket stand-in the test drives: `deliver` a message, `drop` the connection. */
class FakeSocket extends EventTarget {
  binaryType = "blob";
  readyState = 1;
  readonly sent: string[] = [];
  closedWith: number | undefined;

  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000): void {
    this.closedWith = code;
    this.drop();
  }
  deliver(message: BroadcastMessage): void {
    const bytes = encodeBroadcast(message);
    this.dispatchEvent(new MessageEvent("message", { data: bytes.slice().buffer }));
  }
  drop(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  acks(): number[] {
    return this.sent.filter((s) => s !== "ping").map((s) => (JSON.parse(s) as { ack: number }).ack);
  }
}

/** A room: a world with spinning snakes and an encoder over it. */
function room(stream = 1) {
  const world = createWorld({ seed: 4, config: { arenaRadius: 60 } });
  for (const id of ["a", "b", "c"]) spawnSnake(world, { id, author: `${id}-author` });
  const encoder = new BroadcastEncoder(world, { stream, room: "r1", bot: (id) => `v-${id}` });
  return {
    world,
    encoder,
    keyframe: () => encoder.keyframe(world),
    /** `n` ticks as one message (`kill` dies by fault on the first). */
    ticks(n: number, kill?: string): BroadcastMessage {
      const ticks: TickDelta[] = [];
      for (let i = 0; i < n; i++) {
        const actions = Object.fromEntries(world.snakes.map((s) => [s.id, { turn: 0.5 }]));
        step(world, actions, i === 0 && kill ? { [kill]: "error" } : {});
        ticks.push(encoder.step(world));
      }
      return { kind: "ticks", stream: encoder.stream, ticks };
    },
  };
}

function expectFrame(source: BroadcastSource, world: World): void {
  const snap = source.snapshot(world.tick);
  expect(snap?.frame.snakes.map((s) => s.id)).toEqual(world.snakes.map((s) => s.id));
  snap?.frame.snakes.forEach((s, i) => {
    const w = world.snakes[i] as World["snakes"][number];
    expect(s.segments).toHaveLength(w.segments.length);
    expect(s.segments[0]?.x).toBeCloseTo(w.head.x, 4);
    expect(s.radius).toBeCloseTo(w.size / 2, 5);
  });
  expect(snap?.frame.food).toHaveLength(world.food.length);
}

let sockets: FakeSocket[];
const connect = () => {
  const ws = new FakeSocket();
  sockets.push(ws);
  return ws as unknown as WebSocket;
};
const latest = () => sockets[sockets.length - 1] as FakeSocket;

beforeEach(() => {
  sockets = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("BroadcastSource", () => {
  it("opens on the first keyframe and plays the ticks that follow", async () => {
    const r = room();
    const opening = BroadcastSource.open({ connect, timeoutMs: 1000 });
    latest().deliver(r.keyframe());
    const source = await opening;
    expect(source.status).toBe("live");
    expect(source.info).toMatchObject({ tps: 10, arenaRadius: 60, liveDelay: DEFAULT_LIVE_DELAY });
    expect(source.info.title).toBe("r1");
    expect(source.firstTick).toBe(0);
    expect(source.lastTick).toBe(0);
    expectFrame(source, r.world);

    latest().deliver(r.ticks(10, "c"));
    expect(source.lastTick).toBe(10);
    for (let t = 1; t <= 10; t++) expect(source.snapshot(t)?.tick).toBe(t);
    expectFrame(source, r.world);
    // Acked what it applied.
    expect(latest().acks()).toEqual([0, 10]);

    expect(source.snapshot(1)?.deaths).toEqual(["c"]);
    expect(source.life("c")?.death).toMatchObject({ tick: 1, cause: "error", killerId: null });
    expect(source.lives().map((l) => [l.id, l.bot, l.author])).toEqual([
      ["a", "v-a", "a-author"],
      ["b", "v-b", "b-author"],
      ["c", "v-c", "c-author"],
    ]);
    expect(new Set(source.lives().map((l) => l.color)).size).toBe(3);
    source.dispose();
  });

  it("fails to open when nothing comes, and disposes itself", async () => {
    const opening = BroadcastSource.open({ connect, timeoutMs: 1000 });
    const failed = expect(opening).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(1000);
    await failed;
    expect(latest().closedWith).toBe(1000);

    const refused = BroadcastSource.open({ connect, timeoutMs: 1000 });
    latest().drop();
    await expect(refused).rejects.toThrow();
  });

  it("reconnects with backoff and goes on from the keyframe it gets", async () => {
    const r = room();
    const opening = BroadcastSource.open({ connect, timeoutMs: 1000 });
    latest().deliver(r.keyframe());
    const source = await opening;
    latest().deliver(r.ticks(10));

    latest().drop();
    expect(source.status).toBe("reconnecting");
    // Nothing new while away: the history stays readable.
    expect(source.snapshot(5)).toBeDefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    // That one fails too: the next try waits twice as long.
    latest().drop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(3);

    // Same stream, same tick: the history continues.
    latest().deliver(r.keyframe());
    expect(source.status).toBe("live");
    expect(source.firstTick).toBe(0);
    latest().deliver(r.ticks(10));
    expect(source.lastTick).toBe(20);
    expectFrame(source, r.world);

    // A new stream (the room restarted, or another room): the history starts over.
    const other = room(2);
    other.ticks(30);
    latest().drop();
    await vi.advanceTimersByTimeAsync(1000);
    latest().deliver(other.keyframe());
    expect(source.firstTick).toBe(30);
    expect(source.lastTick).toBe(30);
    expect(source.snapshot(10)).toBeUndefined();
    expectFrame(source, other.world);
    source.dispose();
  });

  it("resyncs on a gap instead of showing a wrong world", async () => {
    const r = room();
    const opening = BroadcastSource.open({ connect, timeoutMs: 1000 });
    latest().deliver(r.keyframe());
    const source = await opening;
    r.ticks(10); // lost
    const ws = latest();
    ws.deliver(r.ticks(10));
    expect(ws.closedWith).toBe(4001);
    expect(source.lastTick).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    latest().deliver(r.keyframe());
    expect(source.lastTick).toBe(20);
    expectFrame(source, r.world);
    source.dispose();
  });

  it("keeps a bounded history", async () => {
    const r = room();
    const opening = BroadcastSource.open({ connect, timeoutMs: 1000, maxTicks: 50 });
    latest().deliver(r.keyframe());
    const source = await opening;
    for (let i = 0; i < 20; i++) latest().deliver(r.ticks(10));
    expect(source.lastTick).toBe(200);
    expect(source.firstTick).toBe(151);
    expect(source.snapshot(150)).toBeUndefined();
    expect(source.snapshot(151)).toBeDefined();
    source.dispose();
  });

  it("followLive keeps the playhead behind the bursts, and skips ahead when far behind", async () => {
    const r = room();
    const opening = BroadcastSource.open({ connect, timeoutMs: 1000, maxTicks: 1000 });
    latest().deliver(r.keyframe());
    const source = await opening;
    const playback = new Playback(source);
    playback.seek(source.lastTick);

    // A second of ticks at a time; play 60 frames per second of it.
    let stalls = 0;
    for (let second = 0; second < 20; second++) {
      latest().deliver(r.ticks(10));
      for (let f = 0; f < 60; f++) {
        followLive(playback);
        const before = playback.position;
        playback.update(1 / 60);
        if (second > 3 && playback.position === before) stalls++;
      }
    }
    // Once it has settled it never sits waiting at the live edge.
    expect(stalls).toBe(0);
    const lag = source.lastTick - playback.position;
    expect(lag).toBeGreaterThan(DEFAULT_LIVE_DELAY / 2 - 1);
    expect(lag).toBeLessThan(DEFAULT_LIVE_DELAY * 2 + 10);
    expect(playback.sample()?.alpha).toBeGreaterThanOrEqual(0);

    // A hidden tab: the ticks pile up, then it jumps to the latest instead of replaying them.
    for (let i = 0; i < 10; i++) latest().deliver(r.ticks(10));
    followLive(playback);
    expect(source.lastTick - playback.position).toBe(DEFAULT_LIVE_DELAY);
    source.dispose();
  });
});
