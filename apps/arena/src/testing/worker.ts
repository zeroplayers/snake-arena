/**
 * Test entry for `room.test.ts`: the real `RoomDO` (with a sandbox that can be told to burn CPU),
 * a scriptable matchmaker in place of the stub, and `POST /rpc` to call either from Node
 * (`{ target, name, method, args }`). Spectators: `/showcase` as in production, and
 * `/spectate/<room name>` straight to a room.
 */
import { DurableObject } from "cloudflare:workers";
import type { BotLife, InstrumentResult } from "@zerosnake/sandbox";
import type { LifeResult, LifeTicket, MatchmakerRpc, QuarantineRecord } from "../protocol.ts";
import type { LifeStarter } from "../room/sim.ts";
import { RoomDO as BaseRoomDO } from "../room.ts";
import { handleShowcase } from "../showcase.ts";

export { ShowcaseDO } from "../showcase.ts";

import { BURN_LINE, SPIN_PREFIX } from "./burn.ts";

/**
 * `spin` fills this with random bytes over and over: native work, so its speed doesn't depend on
 * how far the JIT optimized the loop (a plain JS loop varied ~30× between runs).
 */
const SPIN_BUFFER = new Uint8Array(65_536);
/** Fills per ms: 25–50 µs each in workerd under Miniflare (measured). */
const SPIN_PER_MS = 35;

/**
 * Busy work for roughly `ms` (within ~2×; the clock doesn't move during CPU work in workerd, so
 * it can't be timed).
 */
function spin(ms: number): void {
  for (let i = 0; i < ms * SPIN_PER_MS; i++) crypto.getRandomValues(SPIN_BUFFER);
}

/** Storage key of `slowInstrument`'s delay (it survives restarts, like a slow machine). */
const INSTRUMENT_DELAY_KEY = "test:instrumentDelayMs";

/**
 * The real room, but each bot tick may ask the host to burn CPU through its log. That's what an
 * operation the sandbox's meter can't charge looks like to the room: a call that doesn't return.
 * The tests don't depend on which such holes the sandbox still has (#62 closed the string ones).
 */
export class RoomDO extends BaseRoomDO {
  /**
   * Makes instrumenting each bundle take `ms` longer (wall time), as on a slow machine, for this
   * room from now on.
   */
  async slowInstrument(ms: number): Promise<void> {
    await this.ctx.storage.put(INSTRUMENT_DELAY_KEY, ms);
  }

  protected override async instrumentBundle(source: string): Promise<InstrumentResult> {
    const ms = (await this.ctx.storage.get<number>(INSTRUMENT_DELAY_KEY)) ?? 0;
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    return super.instrumentBundle(source);
  }

  protected override async newLifeStarter(): Promise<LifeStarter> {
    const starter = await super.newLifeStarter();
    return {
      prepare: (sources) => starter.prepare(sources),
      startLife: (source, info) => burnOnRequest(starter.startLife(source, info)),
    };
  }
}

function burnOnRequest(life: BotLife): BotLife {
  return new Proxy(life, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== "tick") return typeof value === "function" ? value.bind(target) : value;
      return (...args: Parameters<BotLife["tick"]>) => {
        const report = target.tick(...args);
        for (const line of report.log.lines) {
          if (line === BURN_LINE) for (;;) spin(1000);
          if (line.startsWith(SPIN_PREFIX)) spin(Number(line.slice(SPIN_PREFIX.length)));
        }
        return report;
      };
    },
  });
}

interface Call {
  target: "room" | "matchmaker" | "showcase";
  name?: string;
  method: string;
  args?: unknown[];
}

export interface MatchmakerEvent {
  kind: "nextLife" | "lifeEnded" | "versionQuarantined" | "roomClosed";
  body: unknown;
}

/** A FIFO of tickets the test offers; records everything rooms tell it. */
export class TestMatchmaker extends DurableObject<Env> implements MatchmakerRpc {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tickets (seq INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL,
        room TEXT);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, json TEXT);
    `);
  }

  /** Queues a ticket for any room, or only for `roomId`. */
  async offer(ticket: LifeTicket, roomId: string | null = null): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT INTO tickets (json, room) VALUES (?, ?)",
      JSON.stringify(ticket),
      roomId,
    );
  }

  async events(): Promise<MatchmakerEvent[]> {
    return this.ctx.storage.sql
      .exec<{ kind: string; json: string }>("SELECT kind, json FROM events ORDER BY seq")
      .toArray()
      .map((r) => ({ kind: r.kind as MatchmakerEvent["kind"], body: JSON.parse(r.json) }));
  }

  async nextLife(request: {
    roomId: string;
    excludeAuthors: string[];
  }): Promise<LifeTicket | null> {
    this.record("nextLife", request);
    const rows = this.ctx.storage.sql
      .exec<{ seq: number; json: string }>(
        "SELECT seq, json FROM tickets WHERE room IS NULL OR room = ? ORDER BY seq",
        request.roomId,
      )
      .toArray();
    for (const row of rows) {
      const ticket = JSON.parse(row.json) as LifeTicket;
      if (request.excludeAuthors.includes(ticket.author)) continue;
      this.ctx.storage.sql.exec("DELETE FROM tickets WHERE seq = ?", row.seq);
      return ticket;
    }
    return null;
  }

  async lifeEnded(result: LifeResult): Promise<void> {
    this.record("lifeEnded", result);
  }

  async versionQuarantined(record: QuarantineRecord): Promise<void> {
    this.record("versionQuarantined", record);
  }

  async roomClosed(roomId: string): Promise<void> {
    this.record("roomClosed", roomId);
  }

  private record(kind: MatchmakerEvent["kind"], body: unknown): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO events (kind, json) VALUES (?, ?)",
      kind,
      JSON.stringify(body),
    );
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/showcase") return handleShowcase(request, env);
    if (path.startsWith("/spectate/")) {
      const name = decodeURIComponent(path.slice("/spectate/".length));
      return env.ROOMS.get(env.ROOMS.idFromName(name)).fetch(request);
    }
    const call = (await request.json()) as Call;
    const ns =
      call.target === "room"
        ? env.ROOMS
        : call.target === "showcase"
          ? env.SHOWCASE
          : env.MATCHMAKER;
    const stub = ns.get(ns.idFromName(call.name ?? "global")) as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    try {
      const fn = stub[call.method];
      if (!fn) throw new Error(`no method ${call.method}`);
      return Response.json({ ok: true, value: (await fn(...(call.args ?? []))) ?? null });
    } catch (e) {
      return Response.json({ ok: false, error: String(e) });
    }
  },
} satisfies ExportedHandler<Env>;
