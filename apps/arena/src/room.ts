import { DurableObject } from "cloudflare:workers";

/**
 * One persistent room of 10–20 snakes, simulated in batches of ticks from `alarm()`.
 * See SPEC §4–5. Stub until the rooms issue lands.
 */
export class RoomDO extends DurableObject<Env> {
  async ping(): Promise<string> {
    return "room:ok";
  }
}
