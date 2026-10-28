/**
 * What the room tests share: one workerd per test file (the backstop's tests wait out wall-clock
 * kills, so they're split over files that run in parallel) and the helpers that drive a room.
 */
import { afterAll, beforeAll, expect } from "vitest";
import { bundleHouseBots } from "../../scripts/house-bundles.ts";
import type { LifeResult, LifeTicket, RoomStatus } from "../protocol.ts";
import { KILLS_TO_EVICT } from "../room/backstop.ts";
import { createHarness, type Harness, seedVersion } from "./harness.ts";
import type { MatchmakerEvent } from "./worker.ts";

export let h: Harness;
export let house: Record<string, string>;

/** Starts this file's workerd (and bundles the house bots) before its tests, and stops it after. */
export function useRoomHarness(): void {
  beforeAll(async () => {
    [h, house] = await Promise.all([createHarness(), bundleHouseBots()]);
  }, 120_000);

  afterAll(async () => {
    await h?.dispose();
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function ticket(author: string, source: string, lifeId?: string): Promise<LifeTicket> {
  return seedVersion(await h.d1(), author, source, lifeId);
}

// The backstop tests' burning bots circle in place until they burn; on some seeds another snake
// runs across them first (seed 7 did on the square arena, #76), and the life the test expects to
// burn is gone.
export const ROOM_SEED = 8;

export async function startRoom(name: string, tickets: LifeTicket[], options: object = {}) {
  await h.room(name, "start", { roomId: name, seed: ROOM_SEED, manual: true, ...options });
  for (const t of tickets) expect(await h.room(name, "join", t)).toEqual({ ok: true });
}

export const events = () => h.call<MatchmakerEvent[]>("matchmaker", "events");
export const status = (name: string) => h.room<RoomStatus>(name, "status");

export async function lifeRow(id: string) {
  const db = await h.d1();
  return db.prepare("SELECT * FROM lives WHERE id = ?").bind(id).first<Record<string, unknown>>();
}

/**
 * Runs batches the way alarms would. A batch that doesn't return within `hangMs` is stuck in a
 * bot: workerd is restarted, as Cloudflare's CPU limit would reset the object. Stops when `done`
 * holds. Returns how many times the room was killed.
 *
 * `hangMs` stands in for the CPU limit, but in wall time, so it is set well above the rooms'
 * `cpuLimitMs`: a watched batch spends wall time waiting (syncs, random gaps) that uses no CPU.
 */
export async function drive(
  name: string,
  done: (s: RoomStatus) => boolean,
  { hangMs = 4000, max = 40 } = {},
): Promise<{ kills: number; s: RoomStatus }> {
  let kills = 0;
  let last: RoomStatus | null = null;
  for (let i = 0; i < max; i++) {
    const finished = await Promise.race([
      h.fire(name, "runBatch").then(() => true),
      sleep(hangMs).then(() => false),
    ]);
    if (!finished) {
      kills++;
      await h.restart();
    }
    const s = await status(name);
    last = s;
    if (done(s)) return { kills, s };
  }
  const { tick, incidents, evictions, kills: window, snakes } = last ?? ({} as RoomStatus);
  throw new Error(
    `room ${name}: condition not reached in ${max} batches (${kills} kills): ` +
      JSON.stringify({ tick, incidents, evictions, window, snakes: snakes?.map((x) => x.lifeId) }),
  );
}

/**
 * Runs batches until the room is `ticks` past where it is (it stays open: tests keep honest lives
 * queued for it). Fails instead of spinning if it doesn't get there.
 */
export async function advance(name: string, ticks: number, max = 100): Promise<RoomStatus> {
  let s = await h.room<RoomStatus>(name, "runBatch");
  const target = s.tick + ticks;
  for (let i = 0; s.tick < target; i++) {
    if (s.state !== "running" || i >= max) {
      throw new Error(`room ${name} stopped at tick ${s.tick} (${s.state}), wanted ${target}`);
    }
    s = await h.room<RoomStatus>(name, "runBatch");
  }
  return s;
}

/** Honest lives queued for room `name` only, so it never runs out of real lives and closes. */
export async function spares(name: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await h.call(
      "matchmaker",
      "offer",
      await ticket(`${name}-spare${i}`, house.medium as string),
      name,
    );
  }
}

/** Lives the room reported to the matchmaker as `evicted`. */
export async function evictedLives(): Promise<LifeResult[]> {
  return (await events())
    .filter((e) => e.kind === "lifeEnded")
    .map((e) => e.body as LifeResult)
    .filter((l) => l.deathCause === "evicted");
}

/** Small CPU limit and batches, so "killed after 1.5 s" counts as CPU-limit evidence. */
export const limits = { cpuLimitMs: 1000, batchTicks: 50 };
export const outcomes = (s: RoomStatus) => s.incidents.map((i) => i.outcome);
export const evictionKills = ["suspect", "suspect", "evicted"].slice(-KILLS_TO_EVICT);
