/**
 * The replay page's trace panel: the selected life's trace, for the signed-in owner of its bot
 * only (`src/queries/trace.ts`). Fetched by the page after it loads, never server-rendered, so the
 * page itself stays the same for everyone.
 */
import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { type OwnTrace, readLifeTrace } from "../queries/trace";
import { getAuth, getDb } from "./env";

export type ReplayTrace =
  | { status: "ok"; trace: OwnTrace }
  /** Not signed in, or not the bot's owner: traces are private. */
  | { status: "private"; signedIn: boolean }
  | { status: "none" }
  | { status: "expired" };

export const getReplayTrace = createServerFn({ method: "GET" })
  .validator(z.string().min(1).max(128))
  .handler(async ({ data }): Promise<ReplayTrace> => {
    const session = await getAuth().api.getSession({ headers: getRequest().headers });
    if (!session) return { status: "private", signedIn: false };
    const read = await readLifeTrace(getDb(), env.TRACES, data, session.user.id);
    switch (read.status) {
      case "forbidden":
        return { status: "private", signedIn: true };
      case "not_found":
        return { status: "none" };
      default:
        return read;
    }
  });
