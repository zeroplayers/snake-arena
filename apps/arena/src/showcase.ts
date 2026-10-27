/**
 * The live showcase (#27, SPEC §4): which rooms the home page shows, and the spectator route.
 *
 * Rooms report themselves to `ShowcaseDO` (one global instance) every `SHOWCASE_REPORT_MS` while
 * they run, and leave when they close. `GET /showcase` (a WebSocket upgrade; `?slot=1` for the
 * second room) asks it for the showcase rooms and hands the socket to the room in that slot, which
 * runs in real time while it has spectators (`room/spectators.ts`). The site proxies
 * `/api/showcase` here (apps/web `src/server/showcase.ts`), so browsers stay on its origin.
 *
 * **The rule** (`pickShowcase`, `showcase/rule.ts`): a showcase room keeps its slot while it is alive and still has a
 * deployed bot in it, so spectators aren't bounced between rooms and at most `SHOWCASE_SLOTS`
 * rooms ever run in real time. An empty slot goes to the room with the most deployed bots, then
 * the most snake mass (longer snakes, more fights). No ratings involved: rooms don't know them.
 *
 * **The seam for the matchmaker (#23)**, which knows every room and its versions' ratings:
 * `ShowcaseRpc.pin(objectIds)` overrides the rule with its own choice (null hands it back).
 */
import { DurableObject } from "cloudflare:workers";
import {
  pickShowcase,
  SHOWCASE_SLOTS,
  type ShowcaseCandidate,
  type ShowcaseRpc,
} from "./showcase/rule.ts";

export {
  SHOWCASE_REPORT_MS,
  SHOWCASE_SLOTS,
  type ShowcaseCandidate,
  type ShowcaseRpc,
} from "./showcase/rule.ts";

/**
 * The registry. Candidates are kept in memory (rooms report again within `SHOWCASE_REPORT_MS`);
 * the current picks and a pin are stored, so the showcase doesn't jump after an eviction.
 */
export class ShowcaseDO extends DurableObject<Env> implements ShowcaseRpc {
  private readonly candidates = new Map<string, ShowcaseCandidate>();

  async report(candidate: ShowcaseCandidate): Promise<void> {
    this.candidates.set(candidate.objectId, candidate);
  }

  async remove(objectId: string): Promise<void> {
    this.candidates.delete(objectId);
    const current = (await this.ctx.storage.get<string[]>("current")) ?? [];
    if (current.includes(objectId)) {
      await this.ctx.storage.put(
        "current",
        current.filter((id) => id !== objectId),
      );
    }
  }

  async rooms(): Promise<string[]> {
    const pinned = await this.ctx.storage.get<string[]>("pinned");
    if (pinned) return pinned.slice(0, SHOWCASE_SLOTS);
    const current = (await this.ctx.storage.get<string[]>("current")) ?? [];
    // Right after an eviction nobody has reported yet: keep showing what was there.
    if (this.candidates.size === 0) return current;
    const next = pickShowcase([...this.candidates.values()], current, Date.now());
    if (next.join() !== current.join()) await this.ctx.storage.put("current", next);
    return next;
  }

  async pin(objectIds: string[] | null): Promise<void> {
    if (objectIds) await this.ctx.storage.put("pinned", objectIds.slice(0, SHOWCASE_SLOTS));
    else await this.ctx.storage.delete("pinned");
  }
}

export function showcase(env: Env): ShowcaseRpc {
  return env.SHOWCASE.get(env.SHOWCASE.idFromName("global"));
}

/** `GET /showcase[?slot=n]`: a spectator's WebSocket, handed to the showcase room in that slot. */
export async function handleShowcase(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }
  const slot = Number(new URL(request.url).searchParams.get("slot") ?? 0);
  if (!Number.isInteger(slot) || slot < 0 || slot >= SHOWCASE_SLOTS) {
    return new Response("No such showcase slot", { status: 400 });
  }
  const registry = showcase(env);
  const id = (await registry.rooms())[slot];
  if (!id) return new Response("No showcase room right now", { status: 503 });
  const response = await env.ROOMS.get(env.ROOMS.idFromString(id)).fetch(request);
  // Closed since its last report: forget it, so the spectator's retry finds another room.
  if (response.status === 410) await registry.remove(id);
  return response;
}
