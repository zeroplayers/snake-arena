/**
 * `Spectators` in Node, over a stand-in for the Durable Object's sockets: what a failed batch,
 * labels, silent sockets and leaving the showcase do. (`../spectators.test.ts` runs it in workerd.)
 */
import {
  type BroadcastLabel,
  type BroadcastMessage,
  BroadcastView,
  createWorld,
  decodeBroadcast,
  spawnSnake,
  step,
} from "@zerosnake/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { type SpectatedLife, Spectators } from "./spectators.ts";

class FakeSocket {
  readyState = 1;
  readonly messages: BroadcastMessage[] = [];
  readonly view = new BroadcastView();
  closed: { code: number; reason: string } | null = null;

  send(bytes: Uint8Array): void {
    const message = decodeBroadcast(bytes);
    this.messages.push(message);
    this.view.apply(message);
  }
  close(code: number, reason: string): void {
    this.readyState = 2;
    this.closed = { code, reason };
  }
}

beforeAll(() => {
  // workerd globals `Spectators` touches.
  Object.assign(globalThis, { WebSocketRequestResponsePair: class {} });
});

/** A room of two deployed bots and two house bots of one kind, its sockets, its `Spectators`. */
function setup(lookup = async (ids: string[]) => labelsFor(ids)) {
  const world = createWorld({ seed: 7 });
  const lives: Record<string, SpectatedLife> = {
    "life-a": { versionId: "v-a", house: null, author: "user-a" },
    "life-b": { versionId: "v-b", house: null, author: "user-b" },
    "life-h": { versionId: null, house: "hard", author: "house:hard" },
    "life-h2": { versionId: null, house: "hard", author: "house:hard#2" },
  };
  for (const id of Object.keys(lives)) spawnSnake(world, { id, author: `u-${id}` });
  const sockets: FakeSocket[] = [];
  const lookups: string[][] = [];
  const ctx = {
    setWebSocketAutoResponse() {},
    getWebSockets: () => sockets,
  } as unknown as DurableObjectState;
  const spectators = new Spectators(
    ctx,
    () => ({
      roomId: "room-1",
      idleWorld: () => world,
      life: (id) => lives[id] ?? null,
      versionIds: () => Object.values(lives).flatMap((l) => (l.versionId ? [l.versionId] : [])),
    }),
    async (ids) => {
      lookups.push(ids);
      return lookup(ids);
    },
  );
  /** A socket that joined (as after hibernation: it gets a keyframe after the next batch). */
  const join = () => {
    const ws = new FakeSocket();
    sockets.push(ws);
    return ws;
  };
  /** One batch of `n` ticks, as `RoomDO` runs it; `fail` throws it away like a dying batch. */
  const batch = async (n: number, fail = false) => {
    await spectators.prepare();
    const afterStep = spectators.beginBatch(world);
    const before = structuredClone(world);
    for (let i = 0; i < n; i++) {
      step(world, {});
      afterStep?.(world);
    }
    if (fail) {
      spectators.abort();
      // The room picks up from the saved frame.
      Object.assign(world, before);
    } else {
      spectators.commit(world);
    }
  };
  return { world, sockets, lookups, spectators, join, batch, lives };
}

function labelsFor(ids: string[]): Map<string, BroadcastLabel> {
  const all: Record<string, BroadcastLabel> = {
    "v-a": { author: "ada", bot: "ouroboros", version: 3, house: false },
    "v-b": { author: "bob", bot: "noodle", version: 1, house: false },
  };
  return new Map(ids.flatMap((id) => (all[id] ? [[id, all[id]] as const] : [])));
}

const kinds = (ws: FakeSocket) => ws.messages.map((m) => m.kind);

describe("Spectators", () => {
  it("a failed batch never reaches spectators: the next one starts a new stream", async () => {
    const s = setup();
    const ws = s.join();
    await s.batch(10);
    expect(kinds(ws)).toEqual(["keyframe"]);
    await s.batch(10);
    expect(kinds(ws)).toEqual(["keyframe", "ticks"]);
    const stream = ws.view.stream;
    const saved = s.world.tick;

    await s.batch(10, true);
    // Nothing of the dead batch went out.
    expect(ws.messages).toHaveLength(2);
    expect(ws.view.tick).toBe(saved);

    await s.batch(10);
    expect(kinds(ws)).toEqual(["keyframe", "ticks", "keyframe"]);
    expect(ws.view.stream).not.toBe(stream);
    expect(ws.view.tick).toBe(s.world.tick);
    await s.batch(10);
    expect(kinds(ws).at(-1)).toBe("ticks");
    expect(ws.view.tick).toBe(s.world.tick);
  });

  it("labels lives with public names, looked up once per version; house copies numbered", async () => {
    const s = setup();
    const ws = s.join();
    await s.batch(5);
    await s.batch(5);
    expect(s.lookups).toEqual([["v-a", "v-b"]]);
    const labels = ws.view.snakes.map(({ life: { slot: _, bornTick: __, ...label } }) => label);
    expect(labels).toEqual([
      { author: "ada", bot: "ouroboros", version: 3, house: false },
      { author: "bob", bot: "noodle", version: 1, house: false },
      { author: "house", bot: "hard", version: 0, house: true },
      { author: "house", bot: "hard #2", version: 0, house: true },
    ]);

    // A new version is looked up alone.
    s.lives["life-c"] = { versionId: "v-c", house: null, author: "user-c" };
    spawnSnake(s.world, { id: "life-c", author: "u-c" });
    await s.batch(5);
    expect(s.lookups).toEqual([["v-a", "v-b"], ["v-c"]]);
    // D1 doesn't know it: it shows as unknown, not as anything internal.
    expect(ws.view.snakes.at(-1)?.life).toMatchObject({ author: "", bot: "", version: 0 });
  });

  it("a failed lookup is retried, the lives meanwhile unnamed", async () => {
    let fail = true;
    const s = setup(async (ids) => {
      if (fail) throw new Error("D1 down");
      return labelsFor(ids);
    });
    const ws = s.join();
    await s.batch(5);
    expect(ws.view.snakes[0]?.life).toMatchObject({ author: "", bot: "" });
    fail = false;
    await s.batch(5);
    expect(s.lookups).toHaveLength(2);
    // Snakes keep the label they were first sent with; a new spectator gets the names.
    const late = s.join();
    await s.batch(5);
    expect(late.view.snakes[0]?.life).toMatchObject({ author: "ada", bot: "ouroboros" });
  });

  it("looks nothing up while nobody watches", async () => {
    const s = setup();
    await s.batch(5);
    expect(s.lookups).toEqual([]);
  });

  it("closes sockets that stop acking, and their leaving starts no grace period", async () => {
    const s = setup();
    const quiet = s.join();
    const acking = s.join();
    const ack = () =>
      s.spectators.message(acking as unknown as WebSocket, JSON.stringify({ ack: s.world.tick }));
    await s.batch(5);
    // A keyframe needs no ack, and a room that sent nothing for a while closes nobody.
    await new Promise((r) => setTimeout(r, 30));
    s.spectators.beginBatch(s.world);
    s.spectators.commit(s.world, 20);
    expect(quiet.closed).toBeNull();
    await s.batch(5);
    ack();
    await new Promise((r) => setTimeout(r, 30));
    ack();
    s.spectators.beginBatch(s.world);
    s.spectators.commit(s.world, 20);
    expect(quiet.closed).toEqual({ code: 4002, reason: "no acks" });
    expect(acking.closed).toBeNull();
    expect(s.spectators.count).toBe(1);

    s.spectators.closed(quiet as unknown as WebSocket, 4002, "no acks");
    s.sockets.splice(s.sockets.indexOf(quiet), 1);
    expect(s.spectators.wantsRealtime(Date.now(), 1000)).toBe(true);
    acking.close(1000, "bye");
    s.spectators.release("bye");
    expect(s.spectators.wantsRealtime(Date.now(), 1000)).toBe(false);
    // One that leaves by itself starts the grace period.
    s.spectators.closed(acking as unknown as WebSocket, 1000, "bye");
    expect(s.spectators.wantsRealtime(Date.now(), 1000)).toBe(true);
    expect(s.spectators.wantsRealtime(Date.now() + 1000, 1000)).toBe(false);
  });

  it("release: everyone goes, and the room is back to its own pace at once", async () => {
    const s = setup();
    const a = s.join();
    const b = s.join();
    await s.batch(5);
    expect(s.spectators.wantsRealtime(Date.now())).toBe(true);
    s.spectators.release("showcase moved");
    expect(a.closed).toEqual({ code: 4000, reason: "showcase moved" });
    expect(b.closed?.code).toBe(4000);
    for (const ws of [a, b]) s.spectators.closed(ws as unknown as WebSocket, 4000, "");
    expect(s.spectators.count).toBe(0);
    expect(s.spectators.wantsRealtime(Date.now())).toBe(false);
  });
});
