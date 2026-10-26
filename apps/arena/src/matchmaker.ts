import { DurableObject } from "cloudflare:workers";
import type { BanRecord, LifeResult, LifeTicket, MatchmakerRpc } from "./protocol.ts";

/**
 * Single global instance (`idFromName("global")`) holding the queue of pending lives.
 * See SPEC §4. Stub until the matchmaker issue lands: it implements the room-facing
 * `MatchmakerRpc` with an empty queue.
 */
export class MatchmakerDO extends DurableObject<Env> implements MatchmakerRpc {
  async ping(): Promise<string> {
    return "matchmaker:ok";
  }

  async nextLife(_request: {
    roomId: string;
    excludeAuthors: string[];
  }): Promise<LifeTicket | null> {
    return null;
  }

  async lifeEnded(_result: LifeResult): Promise<void> {}

  async versionBanned(ban: BanRecord): Promise<void> {
    console.warn("version banned (stub matchmaker)", ban.versionId, ban.message);
  }

  async roomClosed(_roomId: string): Promise<void> {}
}
