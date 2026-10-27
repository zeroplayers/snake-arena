import { BroadcastEncoder, createWorld, encodeBroadcast, spawnSnake } from "@zerosnake/engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHeroSource,
  holdLive,
  LIVE_LOST_FAILURES,
  LIVE_LOST_MS,
  type LiveStatusListener,
  watchLive,
} from "./heroSource";

describe("createHeroSource", () => {
  it("plays the live showcase when there is one", async () => {
    const { LiveEngineSource } = await import("@zerosnake/viewer");
    const showcase = new LiveEngineSource({ bots: [], seed: 1 });
    const hero = await createHeroSource({ live: async () => showcase });
    expect(hero).toEqual({ source: showcase, live: true });
  });

  it("falls back to a house-bot match a few hundred ticks in, and keeps going", async () => {
    const { source, live } = await createHeroSource({
      seed: 7,
      live: () => Promise.reject(new Error("no showcase room")),
    });
    expect(live).toBe(false);
    expect(source.endTick).toBeUndefined();
    expect(source.lastTick).toBeGreaterThanOrEqual(300);
    const bots = new Set(source.lives().map((l) => l.bot));
    expect(bots.size).toBe(8);

    const tick = source.lastTick + 100;
    source.request(tick);
    const snap = source.snapshot(tick);
    expect(snap?.frame.snakes.length).toBeGreaterThan(0);
    expect(snap?.frame.arenaHalfSize).toBe(34);
  });

  it("falls back where there is no WebSocket to the site (server render, tests)", async () => {
    const { live } = await createHeroSource({ seed: 1 });
    expect(live).toBe(false);
  });

  it("tells the page once the showcase it played is lost", async () => {
    const { LiveEngineSource } = await import("@zerosnake/viewer");
    let onStatus: LiveStatusListener = () => {};
    const lost = vi.fn();
    const hero = await createHeroSource({
      live: async (listener) => {
        onStatus = listener;
        return new LiveEngineSource({ bots: [], seed: 1 });
      },
      onLiveLost: lost,
    });
    expect(hero.live).toBe(true);
    onStatus("live", 0);
    for (let n = 1; n <= LIVE_LOST_FAILURES; n++) onStatus("reconnecting", n);
    expect(lost).toHaveBeenCalledTimes(1);
  });
});

describe("watchLive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up after failed reconnects in a row, once", () => {
    const lost = vi.fn();
    const watch = watchLive(lost);
    watch("live", 0);
    for (let n = 1; n < LIVE_LOST_FAILURES; n++) watch("reconnecting", n);
    expect(lost).not.toHaveBeenCalled();
    // Back before the limit: counting starts over.
    watch("live", 0);
    for (let n = 1; n < LIVE_LOST_FAILURES; n++) watch("reconnecting", n);
    expect(lost).not.toHaveBeenCalled();
    watch("reconnecting", LIVE_LOST_FAILURES);
    expect(lost).toHaveBeenCalledTimes(1);
    watch("reconnecting", LIVE_LOST_FAILURES + 1);
    vi.advanceTimersByTime(10 * LIVE_LOST_MS);
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it("gives up when it isn't live again in time", () => {
    const lost = vi.fn();
    const watch = watchLive(lost);
    watch("live", 0);
    watch("reconnecting", 1);
    vi.advanceTimersByTime(LIVE_LOST_MS - 1);
    expect(lost).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it("a suspended showcase isn't lost; one that doesn't come back after resuming is", () => {
    const lost = vi.fn();
    const watch = watchLive(lost);
    watch("live", 0);
    watch("reconnecting", 1);
    watch("suspended", 1);
    vi.advanceTimersByTime(60 * LIVE_LOST_MS);
    expect(lost).not.toHaveBeenCalled();
    watch("reconnecting", 0);
    vi.advanceTimersByTime(LIVE_LOST_MS);
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it("leaves opening to createHeroSource", () => {
    const lost = vi.fn();
    const watch = watchLive(lost);
    for (let n = 1; n <= 5; n++) watch("connecting", n);
    vi.advanceTimersByTime(10 * LIVE_LOST_MS);
    expect(lost).not.toHaveBeenCalled();
  });
});

describe("holdLive", () => {
  it("closes the showcase's socket while the hero isn't watched, and reconnects after", async () => {
    const { BroadcastSource } = await import("@zerosnake/viewer");
    const sockets: FakeSocket[] = [];
    const world = createWorld({ seed: 2 });
    spawnSnake(world, { id: "a", author: "u" });
    const encoder = new BroadcastEncoder(world, {
      stream: 1,
      label: () => ({ author: "ada", bot: "noodle", version: 1, house: false }),
    });
    const source = new BroadcastSource({
      connect: () => {
        const ws = new FakeSocket();
        sockets.push(ws);
        return ws as unknown as WebSocket;
      },
    });
    sockets[0]?.deliver(encodeBroadcast(encoder.keyframe(world)));
    expect(source.status).toBe("live");

    holdLive(source, false);
    expect(sockets[0]?.closedWith).toBe(1000);
    expect(source.status).toBe("suspended");
    holdLive(source, false);
    expect(sockets).toHaveLength(1);

    holdLive(source, true);
    expect(sockets).toHaveLength(2);
    sockets[1]?.deliver(encodeBroadcast(encoder.keyframe(world)));
    expect(source.status).toBe("live");
    source.dispose();
  });
});

class FakeSocket extends EventTarget {
  binaryType = "blob";
  readyState = 1;
  closedWith: number | undefined;
  send(): void {}
  close(code = 1000): void {
    this.closedWith = code;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  deliver(bytes: Uint8Array): void {
    this.dispatchEvent(new MessageEvent("message", { data: bytes.slice().buffer }));
  }
}
