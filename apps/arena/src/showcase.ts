/**
 * The live showcase (#27, SPEC §4): which room the home page shows, and the spectator route.
 *
 * Rooms report themselves to `ShowcaseDO` (one global instance) every `SHOWCASE_REPORT_MS` while
 * they run, and leave when they close. A spectator's WebSocket upgrade asks it for the showcase
 * room and is handed to that room, which runs in real time while it has spectators
 * (`room/spectators.ts`).
 *
 * **Only through the site.** The route is `ShowcaseEntrypoint`, a named entrypoint: it has no
 * public URL, only the site's `SHOWCASE` service binding reaches it (apps/web
 * `src/server/showcase.ts`, which rate-limits upgrades per IP and says who the client is in
 * `SHOWCASE_CLIENT_HEADER`). The Worker's public `fetch` has no showcase route. Rooms take a
 * few sockets per client (`MAX_SPECTATORS_PER_CLIENT`), keyed by a hash of that header.
 *
 * **The rule** (`pickShowcase`, `showcase/rule.ts`): a showcase room keeps its slot for a turn
 * (`SHOWCASE_TURN_MS`) while it is alive and still has a deployed bot in it, so spectators aren't
 * bounced between rooms; then it rests (`SHOWCASE_REST_MS`), so no room's bots stay slowed to real
 * time for long. An empty slot goes to the room with the most deployed bots, then the most snake
 * mass (longer snakes, more fights). No ratings involved: rooms don't know them. One slot: the
 * home page shows one room, and no other room can be put into real time.
 *
 * **The seam for the matchmaker (#23)**, which knows every room and its versions' ratings:
 * `ShowcaseRpc.pin(objectIds)` overrides the rule with its own choice (null hands it back).
 */
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { SPECTATOR_CLIENT_HEADER } from "./room/spectators.ts";
import {
  pickShowcase,
  SHOWCASE_CLIENT_HEADER,
  SHOWCASE_SLOTS,
  type ShowcaseCandidate,
  type ShowcaseRpc,
  type ShowcaseTurn,
} from "./showcase/rule.ts";

export {
  SHOWCASE_CLIENT_HEADER,
  SHOWCASE_REPORT_MS,
  SHOWCASE_SLOTS,
  type ShowcaseCandidate,
  type ShowcaseRpc,
} from "./showcase/rule.ts";

/** How long a Worker isolate reuses the registry's answer. */
export const SHOWCASE_ROOMS_CACHE_MS = 5000;

/**
 * The registry. Candidates are kept in memory (rooms report again within `SHOWCASE_REPORT_MS`);
 * the turns, the resting rooms and a pin are stored too, so the showcase doesn't jump after an
 * eviction, and read from storage only when the object starts.
 */
export class ShowcaseDO extends DurableObject<Env> implements ShowcaseRpc {
  private readonly candidates = new Map<string, ShowcaseCandidate>();
  private turns: ShowcaseTurn[] = [];
  private resting: Record<string, number> = {};
  private pinned: string[] | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.turns = (await ctx.storage.get<ShowcaseTurn[]>("turns")) ?? [];
      this.resting = (await ctx.storage.get<Record<string, number>>("resting")) ?? {};
      this.pinned = (await ctx.storage.get<string[]>("pinned")) ?? null;
    });
  }

  async report(candidate: ShowcaseCandidate): Promise<{ showcase: boolean }> {
    this.candidates.set(candidate.objectId, candidate);
    return { showcase: (await this.refresh(Date.now())).includes(candidate.objectId) };
  }

  async remove(objectId: string): Promise<void> {
    this.candidates.delete(objectId);
    if (this.turns.some((t) => t.objectId === objectId)) {
      this.turns = this.turns.filter((t) => t.objectId !== objectId);
      await this.ctx.storage.put("turns", this.turns);
    }
  }

  async rooms(): Promise<string[]> {
    return this.refresh(Date.now());
  }

  async pin(objectIds: string[] | null): Promise<void> {
    this.pinned = objectIds ? objectIds.slice(0, SHOWCASE_SLOTS) : null;
    if (this.pinned) await this.ctx.storage.put("pinned", this.pinned);
    else await this.ctx.storage.delete("pinned");
  }

  /** Applies the rule (turns end, rests run out) and returns the showcase rooms by slot. */
  private async refresh(now: number): Promise<string[]> {
    if (this.pinned) return this.pinned;
    // Right after an eviction nobody has reported yet: keep showing what was there.
    if (this.candidates.size === 0) return this.turns.map((t) => t.objectId);
    const next = pickShowcase([...this.candidates.values()], this.turns, this.resting, now);
    if (JSON.stringify(next) !== JSON.stringify({ turns: this.turns, resting: this.resting })) {
      this.turns = next.turns;
      this.resting = next.resting;
      await this.ctx.storage.put({ turns: this.turns, resting: this.resting });
    }
    return this.turns.map((t) => t.objectId);
  }
}

export function showcase(env: Env): ShowcaseRpc {
  return env.SHOWCASE.get(env.SHOWCASE.idFromName("global"));
}

/** The site's way in (its `SHOWCASE` service binding); no public URL reaches it. */
export class ShowcaseEntrypoint extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    return handleShowcase(request, this.env);
  }
}

/** The registry's last non-empty answer in this isolate. */
let cachedRooms: { ids: string[]; at: number } | null = null;

/**
 * A spectator's WebSocket upgrade (from the site's proxy, with `SHOWCASE_CLIENT_HEADER`), handed
 * to the showcase room.
 */
export async function handleShowcase(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }
  const client = request.headers.get(SHOWCASE_CLIENT_HEADER);
  if (!client) return new Response("Spectators come through the site", { status: 403 });
  const now = Date.now();
  if (!cachedRooms || now - cachedRooms.at >= SHOWCASE_ROOMS_CACHE_MS) {
    const ids = await showcase(env).rooms();
    // An empty answer isn't kept: the first room to report is shown at once.
    cachedRooms = ids.length > 0 ? { ids, at: now } : null;
  }
  const id = cachedRooms?.ids[0];
  if (!id) return new Response("No showcase room right now", { status: 503 });
  const headers = new Headers(request.headers);
  headers.delete(SHOWCASE_CLIENT_HEADER);
  headers.set(SPECTATOR_CLIENT_HEADER, await clientKey(client));
  const response = await env.ROOMS.get(env.ROOMS.idFromString(id)).fetch(
    new Request(request.url, { headers }),
  );
  // Closed since its last report: forget it, so the spectator's retry finds another room.
  if (response.status === 410) {
    cachedRooms = null;
    await showcase(env).remove(id);
  }
  return response;
}

/** A client's key for the rooms: a hash, so no IP is kept in socket tags. */
async function clientKey(client: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(client));
  return [...new Uint8Array(digest).slice(0, 12)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
