/**
 * The replay page's trace panel: the selected life's trace, for the signed-in owner of its bot
 * only (`src/queries/trace.ts`). Fetched by the page after it loads, never server-rendered, so the
 * page itself stays the same for everyone.
 */
import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { type ReplayTrace, replayTrace } from "../queries/trace";
import { getAuth, getDb } from "./env";

export type { ReplayTrace };

export const getReplayTrace = createServerFn({ method: "GET" })
  .validator(z.string().min(1).max(128))
  .handler(
    async ({ data }): Promise<ReplayTrace> =>
      replayTrace(
        {
          getSession: (input) => getAuth().api.getSession(input),
          db: getDb(),
          bucket: env.TRACES,
        },
        getRequest().headers,
        data,
      ),
  );
