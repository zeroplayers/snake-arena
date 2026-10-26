import { DurableObject } from "cloudflare:workers";

/**
 * Single global instance (`idFromName("global")`) holding the queue of pending lives.
 * See SPEC §4. Stub until the matchmaker issue lands.
 */
export class MatchmakerDO extends DurableObject<Env> {
  async ping(): Promise<string> {
    return "matchmaker:ok";
  }
}
