import { type BroadcastMessage, BroadcastView, decodeBroadcast } from "@zerosnake/engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHouseBots } from "../scripts/house-bundles.ts";
import type { LifeTicket, RoomStatus } from "./protocol.ts";
import {
  MAX_SPECTATORS_PER_CLIENT,
  MAX_UNACKED_TICKS,
  SPECTATOR_CLIENT_HEADER,
} from "./room/spectators.ts";
import { SHOWCASE_CLIENT_HEADER } from "./showcase/rule.ts";
import { createHarness, type Harness, seedVersion } from "./testing/harness.ts";

let h: Harness;
let house: Record<string, string>;

beforeAll(async () => {
  [h, house] = await Promise.all([createHarness(), bundleHouseBots()]);
}, 120_000);

afterAll(async () => {
  await h?.dispose();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

const status = (name: string) => h.room<RoomStatus>(name, "status");

/** A room with two deployed bots (strong house bots, so they live through the test). */
async function startRoom(name: string, options: object = {}): Promise<LifeTicket[]> {
  const db = await h.d1();
  const tickets = await Promise.all([
    seedVersion(db, `${name}-a`, house.hard as string),
    seedVersion(db, `${name}-b`, house.medium as string),
  ]);
  await h.room(name, "start", { roomId: name, seed: 3, manual: true, ...options });
  for (const t of tickets) expect(await h.room(name, "join", t)).toEqual({ ok: true });
  return tickets;
}

interface Spectator {
  messages: BroadcastMessage[];
  /** Bytes of each message. */
  sizes: number[];
  bytes: Uint8Array[];
  view: BroadcastView;
  /** Acks every message while set. */
  acking: boolean;
  closed: { code: number; reason: string } | null;
  ack(): void;
  send(text: string): void;
  close(): void;
}

/** An upgrade as the site's proxy sends it, from `client`. */
const viaSite = (client = "198.51.100.1") => ({
  Upgrade: "websocket",
  [SHOWCASE_CLIENT_HEADER]: client,
});

async function spectate(path: string, headers: Record<string, string> = {}): Promise<Spectator> {
  const res = await h.fetch(path, { headers: { Upgrade: "websocket", ...headers } });
  const ws = (res as Response & { webSocket: WebSocket | null }).webSocket;
  if (!ws) throw new Error(`no WebSocket: ${res.status} ${await res.text()}`);
  const s: Spectator = {
    messages: [],
    sizes: [],
    bytes: [],
    view: new BroadcastView(),
    acking: true,
    closed: null,
    ack: () => {
      // A message can still arrive after this side closed.
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ack: s.view.tick }));
    },
    send: (text) => ws.send(text),
    close: () => ws.close(1000, "bye"),
  };
  ws.addEventListener("message", (e) => {
    const bytes = new Uint8Array(e.data as ArrayBuffer);
    const message = decodeBroadcast(bytes);
    s.messages.push(message);
    s.sizes.push(bytes.length);
    s.bytes.push(bytes);
    s.view.apply(message);
    if (s.acking) s.ack();
  });
  ws.addEventListener("close", (e) => {
    s.closed = { code: e.code, reason: e.reason };
  });
  ws.accept();
  return s;
}

const kinds = (s: Spectator) => s.messages.map((m) => m.kind);

describe("spectators", () => {
  it("the showcase route hands spectators to a running room, a few per client", async () => {
    // No room has reported yet (manual rooms don't, and this test runs first).
    const none = await h.fetch("/showcase", { headers: viaSite() });
    expect(none.status).toBe(503);
    expect((await h.fetch("/showcase")).status).toBe(426);

    await startRoom("show", { manual: false });
    await until("reported", async () => (await h.call<string[]>("showcase", "rooms")).length > 0);
    // Only through the site: an upgrade that doesn't say who the client is goes nowhere.
    const direct = await h.fetch("/showcase", { headers: { Upgrade: "websocket" } });
    expect(direct.status).toBe(403);
    // Nor does the slot the site never used (`?slot=` is ignored: there is one room).
    expect(await h.call<string[]>("showcase", "rooms")).toHaveLength(1);

    const crowd: Spectator[] = [];
    for (let i = 0; i < MAX_SPECTATORS_PER_CLIENT; i++) {
      crowd.push(await spectate("/showcase?slot=1", viaSite()));
    }
    await until("keyframes", () => crowd.every((s) => s.messages.length >= 1));
    expect((await status("show")).spectators).toBe(MAX_SPECTATORS_PER_CLIENT);
    const extra = await h.fetch("/showcase", { headers: viaSite() });
    expect(extra.status).toBe(429);
    // Another client still gets in; the client key the room sees is a hash, not the IP.
    const other = await spectate("/showcase", viaSite("2001:db8::/64"));
    await until("keyframe", () => other.messages.length >= 1);
    expect((await status("show")).spectators).toBe(MAX_SPECTATORS_PER_CLIENT + 1);
    // One leaves: a place for that client again.
    crowd[0]?.close();
    await until(
      "left",
      async () => (await status("show")).spectators === MAX_SPECTATORS_PER_CLIENT,
    );
    crowd[0] = await spectate("/showcase", viaSite());
    await until("keyframe", () => (crowd[0]?.messages.length ?? 0) >= 1);
    for (const s of [...crowd, other]) s.close();
    // Unattended rooms run on in the background: keep it from racing.
    await h.room("show", "setMode", "realtime");
  }, 60_000);

  it("the Worker's public URL has no showcase route", async () => {
    const res = await h.fetch("/public/showcase", { headers: viaSite() });
    expect(res.status).toBe(404);
    expect((res as Response & { webSocket: WebSocket | null }).webSocket ?? null).toBeNull();
  });

  it("holds the per-client cap against a burst of upgrades on a fresh room", async () => {
    await startRoom("burst");
    // Spawn the deployed lives, so the first upgrades have labels to look up in D1 (an await).
    await h.room("burst", "runBatch");
    const client = { [SPECTATOR_CLIENT_HEADER]: "burst1" };
    const tries = await Promise.all(
      Array.from({ length: MAX_SPECTATORS_PER_CLIENT * 4 }, () =>
        h.fetch("/spectate/burst", { headers: { Upgrade: "websocket", ...client } }),
      ),
    );
    const accepted = tries.filter((r) => r.status === 101);
    expect(accepted.length).toBe(MAX_SPECTATORS_PER_CLIENT);
    expect(tries.filter((r) => r.status === 429).length).toBe(MAX_SPECTATORS_PER_CLIENT * 3);
    for (const r of accepted) {
      const ws = (r as Response & { webSocket: WebSocket | null }).webSocket;
      ws?.accept();
      ws?.close();
    }
  }, 30_000);

  it("caps sockets per client in the room itself", async () => {
    await startRoom("capped");
    const client = { [SPECTATOR_CLIENT_HEADER]: "abc123" };
    const crowd = await Promise.all(
      Array.from({ length: MAX_SPECTATORS_PER_CLIENT }, () => spectate("/spectate/capped", client)),
    );
    await until("keyframes", () => crowd.every((s) => s.messages.length === 1));
    const res = await h.fetch("/spectate/capped", { headers: { Upgrade: "websocket", ...client } });
    expect(res.status).toBe(429);
    for (const s of crowd) s.close();
  }, 30_000);

  it("closes spectators that stop acking", async () => {
    await startRoom("silent", { limits: { spectatorAckTimeoutMs: 500 } });
    const quiet = await spectate("/spectate/silent");
    const busy = await spectate("/spectate/silent");
    await until("keyframes", () => quiet.messages.length === 1 && busy.messages.length === 1);
    quiet.acking = false;
    for (let i = 0; i < 4; i++) {
      await sleep(200);
      await h.room("silent", "runBatch");
    }
    await until("closed", () => quiet.closed !== null);
    expect(quiet.closed?.code).toBe(4002);
    expect(busy.closed).toBeNull();
    expect((await status("silent")).spectators).toBe(1);
    busy.close();
  }, 30_000);

  it("get a keyframe, then each batch's ticks, and match the room", async () => {
    await startRoom("watch");
    await h.room("watch", "runBatch");
    const s = await spectate("/spectate/watch");
    await until("keyframe", () => s.messages.length === 1);
    const first = await status("watch");
    expect(first.spectators).toBe(1);
    expect(first.mode).toBe("realtime");
    expect(s.view.tick).toBe(first.tick);

    for (let i = 0; i < 5; i++) await h.room("watch", "runBatch");
    await until("five batches", () => s.messages.length === 6);
    const now = await status("watch");
    expect(kinds(s)).toEqual(["keyframe", "ticks", "ticks", "ticks", "ticks", "ticks"]);
    // Watched, a batch is a second of real time.
    expect(now.lastBatchTicks).toBeLessThanOrEqual(10);
    expect(s.view.tick).toBe(now.tick);
    expect(s.view.snakes).toHaveLength(now.snakes.length);
    // Public names only: the username, the bot's slug and the version's number.
    const lives = s.view.snakes.map(({ life: { slot: _, bornTick: __, ...label } }) => label);
    expect(lives).toContainEqual({
      author: "watch-a-name",
      bot: "watch-a",
      version: 1,
      house: false,
    });
    expect(lives).toContainEqual({
      author: "watch-b-name",
      bot: "watch-b",
      version: 1,
      house: false,
    });
    const houses = lives.filter((l) => l.house);
    expect(houses.length).toBe(now.snakes.filter((x) => x.house !== null).length);
    for (const l of houses) expect(l).toMatchObject({ author: "house", version: 0 });
    // A second of ticks: a few KB.
    expect(Math.max(...s.sizes.slice(1))).toBeLessThan(16_000);
    s.close();
  }, 60_000);

  it("reconnect: a returning spectator starts again from a keyframe, also after a restart", async () => {
    await startRoom("again");
    const a = await spectate("/spectate/again");
    await h.room("again", "runBatch");
    await until("first batch", () => a.messages.length === 2);
    a.close();
    await until("close", async () => (await status("again")).spectators === 0);
    await h.room("again", "runBatch");

    const b = await spectate("/spectate/again");
    await until("keyframe", () => b.messages.length === 1);
    const kf = b.messages[0];
    expect(kf?.kind).toBe("keyframe");
    // A batch ran unwatched in between: the room stopped encoding, so this is a new stream.
    expect(kf?.stream).not.toBe(a.messages[0]?.stream);
    expect(b.view.tick).toBe((await status("again")).tick);
    await h.room("again", "runBatch");
    await until("deltas", () => b.messages.length === 2);
    expect(kinds(b)).toEqual(["keyframe", "ticks"]);

    // A restart (eviction, deploy) drops every socket; the room picks up from storage and a
    // new spectator gets a new stream.
    await h.restart();
    await until("dropped", () => b.closed !== null);
    const c = await spectate("/spectate/again");
    await until("keyframe after restart", () => c.messages.length === 1);
    expect(c.messages[0]?.stream).not.toBe(b.messages[0]?.stream);
    expect(c.view.tick).toBe(b.view.tick);
    await h.room("again", "runBatch");
    await until("deltas after restart", () => c.messages.length === 2);
    c.close();
  }, 60_000);

  it("backpressure: a spectator that stops acking is skipped, then skips to the latest tick", async () => {
    await startRoom("slow");
    const fast = await spectate("/spectate/slow");
    const slow = await spectate("/spectate/slow");
    await until("keyframes", () => fast.messages.length === 1 && slow.messages.length === 1);
    slow.acking = false;
    const batches = MAX_UNACKED_TICKS / 10 + 4;
    for (let i = 0; i < batches; i++) {
      await h.room("slow", "runBatch");
      await until("fast keeps up", () => fast.messages.length === i + 2);
    }
    const s = await status("slow");
    expect(fast.view.tick).toBe(s.tick);
    // Sent until it was MAX_UNACKED_TICKS behind, then nothing.
    const sent = slow.messages.length;
    expect(sent).toBeLessThan(batches + 1);
    expect(slow.view.tick).toBeLessThan(s.tick);
    expect(s.tick - slow.view.tick).toBeGreaterThan(10);

    // It catches up on what it was sent, acks, and gets the newest frame next.
    slow.ack();
    slow.acking = true;
    await sleep(100);
    await h.room("slow", "runBatch");
    await until("keyframe", () => slow.messages.length === sent + 1);
    expect(slow.messages[sent]?.kind).toBe("keyframe");
    expect(slow.view.tick).toBe((await status("slow")).tick);
    await h.room("slow", "runBatch");
    await until("deltas again", () => slow.messages.length === sent + 2);
    expect(slow.messages[sent + 1]?.kind).toBe("ticks");
    fast.close();
    slow.close();
  }, 60_000);

  it("sends no internal ids: not of lives, users, bots, versions or the room", async () => {
    const db = await h.d1();
    await db.batch([
      db
        .prepare("INSERT INTO users (id, name, email, username) VALUES (?, ?, ?, ?)")
        .bind("u-9f1c", "Ada", "ada@example.com", "ada"),
      db
        .prepare("INSERT INTO bots (id, owner_id, name, slug) VALUES (?, ?, ?, ?)")
        .bind("b-77aa", "u-9f1c", "Ouroboros", "ouroboros"),
      db
        .prepare(
          `INSERT INTO versions (id, bot_id, n, status, bundle_key, source_key)
           VALUES (?, ?, 4, 'ready', 'b', 's')`,
        )
        .bind("v-31d0", "b-77aa"),
    ]);
    await h.room("ids", "start", { roomId: "room-c0de", seed: 5, manual: true });
    const ticket = { lifeId: "life-5e2b", versionId: "v-31d0", author: "u-9f1c" };
    expect(await h.room("ids", "join", { ...ticket, source: house.hard })).toEqual({ ok: true });
    const s = await spectate("/spectate/ids");
    for (let i = 0; i < 3; i++) await h.room("ids", "runBatch");
    await until("batches", () => s.messages.length >= 3);
    const ada = s.view.snakes.find((v) => v.life.author === "ada");
    expect(ada?.life).toMatchObject({ bot: "ouroboros", version: 4, house: false });
    for (const bytes of s.bytes) {
      for (const id of ["u-9f1c", "b-77aa", "v-31d0", "life-5e2b", "room-c0de", "house:"]) {
        expect(utf16Includes(bytes, id), id).toBe(false);
      }
    }
    s.close();
  }, 30_000);

  it("closes spectators that send anything but acks", async () => {
    await startRoom("rude");
    const s = await spectate("/spectate/rude");
    await until("keyframe", () => s.messages.length === 1);
    s.send("x".repeat(1000));
    await until("closed", () => s.closed !== null);
    expect(s.closed?.code).toBe(1008);
  }, 30_000);

  it("runs in real time while watched and goes back after the grace period", async () => {
    await startRoom("pace", { manual: false, limits: { spectatorGraceMs: 1500 } });
    await until("running", async () => (await status("pace")).tick > 50, 30_000);
    expect((await status("pace")).mode).toBe("accelerated");

    const s = await spectate("/spectate/pace");
    await until("realtime", async () => (await status("pace")).mode === "realtime");
    // Let a batch planned before the switch finish.
    await until("a realtime batch", () => s.messages.some((m) => m.kind === "ticks"));
    const t0 = s.view.tick;
    await sleep(3000);
    const ticks = s.view.tick - t0;
    // ~10 per second (bursts of 10 per second, plus scheduling slack).
    expect(ticks).toBeGreaterThanOrEqual(15);
    expect(ticks).toBeLessThanOrEqual(45);
    expect(kinds(s).filter((k) => k === "keyframe").length).toBe(1);

    s.close();
    await sleep(500);
    // The grace period: still real time right after the last spectator left.
    expect((await status("pace")).mode).toBe("realtime");
    await until("accelerated", async () => (await status("pace")).mode === "accelerated", 5000);
    const before = (await status("pace")).tick;
    await sleep(1000);
    expect((await status("pace")).tick - before).toBeGreaterThan(30);
    // Unattended rooms run on in the background: keep it from racing.
    await h.room("pace", "setMode", "realtime");
  }, 60_000);

  it("100 spectators don't slow the simulation", async () => {
    await startRoom("crowd");
    // Batches with nobody watching but in real time, as a baseline.
    await h.room("crowd", "setMode", "realtime");
    const time = async (n: number) => {
      const t = Date.now();
      for (let i = 0; i < n; i++) await h.room("crowd", "runBatch");
      return Date.now() - t;
    };
    await time(3);
    const alone = await time(10);

    const crowd = await Promise.all(Array.from({ length: 100 }, () => spectate("/spectate/crowd")));
    await until("100 keyframes", () => crowd.every((s) => s.messages.length === 1));
    expect((await status("crowd")).spectators).toBe(100);
    const watched = await time(10);
    await until("every batch to everyone", () => crowd.every((s) => s.messages.length === 11));
    const s = await status("crowd");
    for (const c of crowd) expect(c.view.tick).toBe(s.tick);
    // Encoding once and sending the same bytes costs the batch next to nothing.
    expect(watched).toBeLessThan(alone * 2 + 500);
    for (const c of crowd) c.close();
  }, 120_000);

  it("100 spectators of a real-time room keep it at 10 ticks per second", async () => {
    await startRoom("crowd-live", { manual: false, mode: "realtime" });
    const crowd = await Promise.all(
      Array.from({ length: 100 }, () => spectate("/spectate/crowd-live")),
    );
    await until("keyframes", () => crowd.every((s) => s.messages.length >= 1));
    const t0 = (await status("crowd-live")).tick;
    await sleep(4000);
    const ticks = (await status("crowd-live")).tick - t0;
    expect(ticks).toBeGreaterThanOrEqual(30);
    expect(ticks).toBeLessThanOrEqual(55);
    await until("everyone current", async () => {
      const tick = (await status("crowd-live")).tick;
      return crowd.every((c) => c.view.tick >= tick - 10);
    });
    for (const c of crowd) c.close();
  }, 60_000);
});

/** Whether `text` appears in `bytes` as the wire writes strings (UTF-16LE code units). */
function utf16Includes(bytes: Uint8Array, text: string): boolean {
  const needle = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    needle[2 * i] = text.charCodeAt(i) & 0xff;
    needle[2 * i + 1] = text.charCodeAt(i) >> 8;
  }
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let k = 0; k < needle.length; k++) if (bytes[i + k] !== needle[k]) continue outer;
    return true;
  }
  return false;
}
