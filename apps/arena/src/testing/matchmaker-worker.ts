/**
 * Test entry for `matchmaker.test.ts`: the real `MatchmakerDO` (manual, with a clock the test
 * moves), and behind `ROOMS` either the real `RoomDO` or `FakeRoom`, a room without a simulation
 * that the test steps (lives die on request) so hundreds of bots stay cheap. `POST /rpc` calls
 * either from Node, as in `worker.ts`.
 */
import { DurableObject } from "cloudflare:workers";
import { DEFAULT_MATCHMAKER_CONFIG, type MatchmakerConfig } from "../matchmaker/config.ts";
import { MatchmakerDO } from "../matchmaker.ts";
import type {
  JoinResult,
  LifeEndCause,
  LifeResult,
  LifeTicket,
  RoomStartOptions,
  RoomStatus,
} from "../protocol.ts";

export { RoomDO, ShowcaseDO } from "./worker.ts";

/** The real matchmaker: manual (the test runs `tick`), and its clock can be moved forward. */
export class TestMatchmakerDO extends MatchmakerDO {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS test_clock (id INTEGER PRIMARY KEY, offset INTEGER NOT NULL)",
    );
  }

  protected override baseConfig(): MatchmakerConfig {
    return { ...DEFAULT_MATCHMAKER_CONFIG, manual: true };
  }

  protected override now(): number {
    const row = this.ctx.storage.sql
      .exec<{ offset: number }>("SELECT offset FROM test_clock WHERE id = 1")
      .next();
    return Date.now() + (row.done ? 0 : row.value.offset);
  }

  /** Moves the clock `ms` forward. */
  async advance(ms: number): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO test_clock (id, offset) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET offset = offset + excluded.offset`,
      ms,
    );
  }

  /** Reads the matchmaker's own tables. */
  async query(sql: string, ...args: SqlStorageValue[]): Promise<Record<string, unknown>[]> {
    return this.ctx.storage.sql.exec(sql, ...args).toArray();
  }
}

export interface FakeLife {
  lifeId: string;
  versionId: string;
  author: string;
  leaving: boolean;
}

/** What a step did. */
export interface FakeStep {
  ended: string[];
  joined: LifeTicket[];
  state: "running" | "closed";
}

/**
 * A room that holds tickets instead of simulating them. Like `RoomDO`, it refuses a second life
 * of an author, pulls replacements with `nextLife` after lives end, and closes when it has no
 * lives and the matchmaker has none for it. Anything the matchmaker shouldn't have done (a
 * second snake of an author) is recorded as a violation instead of refused, so tests see it.
 */
export class FakeRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY, room_id TEXT NOT NULL,
        max_snakes INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lives (seq INTEGER PRIMARY KEY AUTOINCREMENT,
        life_id TEXT NOT NULL UNIQUE, version_id TEXT NOT NULL, author TEXT NOT NULL,
        leaving INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS violations (seq INTEGER PRIMARY KEY AUTOINCREMENT, what TEXT);
    `);
  }

  private meta(): { roomId: string; maxSnakes: number; state: "running" | "closed" } | null {
    const row = this.ctx.storage.sql
      .exec<{ room_id: string; max_snakes: number; state: string }>(
        "SELECT * FROM meta WHERE id = 1",
      )
      .next();
    if (row.done) return null;
    const { room_id, max_snakes, state } = row.value;
    return { roomId: room_id, maxSnakes: max_snakes, state: state as "running" | "closed" };
  }

  private matchmaker() {
    return this.env.MATCHMAKER.get(this.env.MATCHMAKER.idFromName("global"));
  }

  async start(options: RoomStartOptions = {}): Promise<RoomStatus> {
    if (!this.meta()) {
      this.ctx.storage.sql.exec(
        "INSERT INTO meta (id, room_id, max_snakes, state) VALUES (1, ?, ?, 'running')",
        options.roomId ?? crypto.randomUUID(),
        options.maxSnakes ?? 20,
      );
    }
    return this.status();
  }

  async join(ticket: LifeTicket): Promise<JoinResult> {
    const meta = this.meta();
    if (meta?.state !== "running") return { ok: false, reason: "closed" };
    const lives = this.lives();
    if (lives.some((l) => l.lifeId === ticket.lifeId))
      return { ok: false, reason: "duplicate-life" };
    if (lives.length >= meta.maxSnakes) return { ok: false, reason: "full" };
    this.add(ticket);
    return { ok: true };
  }

  async leave(lifeId: string): Promise<boolean> {
    return (
      this.ctx.storage.sql.exec("UPDATE lives SET leaving = 1 WHERE life_id = ?", lifeId)
        .rowsWritten > 0
    );
  }

  async status(): Promise<RoomStatus> {
    const meta = this.meta();
    return {
      roomId: meta?.roomId ?? null,
      state: meta?.state ?? "new",
      snakes: this.lives().map((l) => ({
        lifeId: l.lifeId,
        versionId: l.versionId,
        author: l.author,
        house: null,
        lifeTick: 0,
        mass: 0,
      })),
      pending: [],
    } as unknown as RoomStatus;
  }

  lives(): FakeLife[] {
    return this.ctx.storage.sql
      .exec<{ life_id: string; version_id: string; author: string; leaving: number }>(
        "SELECT life_id, version_id, author, leaving FROM lives ORDER BY seq",
      )
      .toArray()
      .map((r) => ({
        lifeId: r.life_id,
        versionId: r.version_id,
        author: r.author,
        leaving: r.leaving === 1,
      }));
  }

  async violations(): Promise<string[]> {
    return this.ctx.storage.sql
      .exec<{ what: string }>("SELECT what FROM violations ORDER BY seq")
      .toArray()
      .map((r) => r.what);
  }

  /** Loses a life without telling anyone (a bug, or lost storage). */
  async forget(lifeId: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM lives WHERE life_id = ?", lifeId);
  }

  /**
   * A batch: leaving lives retire, the `deaths` oldest others die of `cause` (`kill` names more),
   * each reported with `lifeEnded` (twice with `redeliver`), then the room asks for replacements
   * until it is full or the matchmaker has none, and closes if it ended up empty.
   */
  async step({
    deaths = 0,
    cause = "collision",
    kill = [],
    redeliver = false,
  }: {
    deaths?: number;
    cause?: LifeEndCause;
    kill?: string[];
    redeliver?: boolean;
  } = {}): Promise<FakeStep> {
    const meta = this.meta();
    if (meta?.state !== "running") return { ended: [], joined: [], state: "closed" };
    const lives = this.lives();
    const dying = [
      ...lives.filter((l) => l.leaving).map((l) => ({ l, cause: "retired" as const })),
      ...lives
        .filter((l) => !l.leaving && kill.includes(l.lifeId))
        .map((l) => ({ l, cause: "collision" as const })),
      ...lives
        .filter((l) => !l.leaving && !kill.includes(l.lifeId))
        .slice(0, deaths)
        .map((l) => ({ l, cause })),
    ];
    const mm = this.matchmaker();
    for (const { l, cause } of dying) {
      this.ctx.storage.sql.exec("DELETE FROM lives WHERE life_id = ?", l.lifeId);
      const now = Date.now();
      const result: LifeResult = {
        lifeId: l.lifeId,
        versionId: l.versionId,
        author: l.author,
        roomId: meta.roomId,
        startTick: 0,
        endTick: 100,
        score: 1,
        lengthMax: 10,
        kills: 0,
        deathCause: cause,
        killer: null,
        replayKey: `${meta.roomId}/0.zsr`,
        startedAt: now,
        endedAt: now,
      };
      await mm.lifeEnded(result);
      if (redeliver) await mm.lifeEnded(result);
    }
    const joined: LifeTicket[] = [];
    let empty = false;
    while (this.lives().length < meta.maxSnakes) {
      const excludeAuthors = this.lives().map((l) => l.author);
      const ticket = await mm.nextLife({ roomId: meta.roomId, excludeAuthors });
      if (!ticket) {
        empty = true;
        break;
      }
      this.add(ticket);
      joined.push(ticket);
    }
    if (empty && this.lives().length === 0) {
      this.ctx.storage.sql.exec("UPDATE meta SET state = 'closed' WHERE id = 1");
      await mm.roomClosed(meta.roomId);
      return { ended: dying.map((d) => d.l.lifeId), joined, state: "closed" };
    }
    return { ended: dying.map((d) => d.l.lifeId), joined, state: "running" };
  }

  private add(ticket: LifeTicket): void {
    if (this.lives().some((l) => l.author === ticket.author)) {
      this.ctx.storage.sql.exec(
        "INSERT INTO violations (what) VALUES (?)",
        `author ${ticket.author} twice in ${this.meta()?.roomId}`,
      );
    }
    if (!ticket.source) {
      this.ctx.storage.sql.exec(
        "INSERT INTO violations (what) VALUES (?)",
        `ticket ${ticket.lifeId} without a bundle`,
      );
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO lives (life_id, version_id, author) VALUES (?, ?, ?)",
      ticket.lifeId,
      ticket.versionId,
      ticket.author,
    );
  }
}

interface Call {
  target: "room" | "matchmaker";
  name?: string;
  method: string;
  args?: unknown[];
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
