import { DurableObject } from "cloudflare:workers";
import type { LifeResult, LifeTicket, MatchmakerRpc, QuarantineRecord } from "./protocol.ts";

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

  async versionQuarantined(record: QuarantineRecord): Promise<void> {
    console.warn("version quarantined (stub matchmaker)", record.versionId, record.message);
  }

  async roomClosed(_roomId: string): Promise<void> {}
}
