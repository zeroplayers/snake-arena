/**
 * Test entry for `room.test.ts`: the real `RoomDO`, a scriptable matchmaker in place of the stub,
 * and `POST /rpc` to call either from Node (`{ target, name, method, args }`).
 */
import { DurableObject } from "cloudflare:workers";
import type { LifeResult, LifeTicket, MatchmakerRpc, QuarantineRecord } from "../protocol.ts";

export { RoomDO } from "../room.ts";

interface Call {
  target: "room" | "matchmaker";
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
      CREATE TABLE IF NOT EXISTS tickets (seq INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, json TEXT);
    `);
  }

  async offer(ticket: LifeTicket): Promise<void> {
    this.ctx.storage.sql.exec("INSERT INTO tickets (json) VALUES (?)", JSON.stringify(ticket));
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
      .exec<{ seq: number; json: string }>("SELECT seq, json FROM tickets ORDER BY seq")
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
    const call = (await request.json()) as Call;
    const ns = call.target === "room" ? env.ROOMS : env.MATCHMAKER;
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
