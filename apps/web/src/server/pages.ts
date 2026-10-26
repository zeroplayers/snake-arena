/**
 * Server functions for the public pages (leaderboard, bot page, replay). Read-only; each
 * validates its input and goes through a query module.
 */

import { env } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { createServerFn } from "@tanstack/react-start";
import { replayChunkInfo } from "@zerosnake/engine";
import { z } from "zod";
import { getLeaderboard, RANKED_MIN_LIVES } from "../db/queries";
import { getBotPage } from "../queries/bot";
import { getParticipants, getReplayKey, getReplayLife, type Participant } from "../queries/replay";
import { readVersionSources } from "../queries/sources";
import { getDb } from "./env";

export const LEADERBOARD_PAGE_SIZE = 50;

const id = z.string().min(1).max(128);

export const getLeaderboardPage = createServerFn({ method: "GET" })
  .validator(z.object({ page: z.number().int().min(1).max(1000) }))
  .handler(async ({ data }) => {
    const offset = (data.page - 1) * LEADERBOARD_PAGE_SIZE;
    // One extra row tells whether there is a next page.
    const rows = await getLeaderboard(getDb(), { limit: LEADERBOARD_PAGE_SIZE + 1, offset });
    return {
      entries: rows.slice(0, LEADERBOARD_PAGE_SIZE),
      page: data.page,
      hasNext: rows.length > LEADERBOARD_PAGE_SIZE,
      minLives: RANKED_MIN_LIVES,
    };
  });

export const getBotPageData = createServerFn({ method: "GET" })
  .validator(
    z.object({
      username: id,
      bot: id,
      version: z.number().int().min(1).optional(),
      page: z.number().int().min(1).max(1000).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const page = await getBotPage(getDb(), data.username, data.bot, {
      ...(data.version !== undefined && { version: data.version }),
      ...(data.page !== undefined && { page: data.page }),
    });
    return page && { ...page, minLives: RANKED_MIN_LIVES };
  });

export const getVersionSources = createServerFn({ method: "GET" })
  .validator(id)
  .handler(({ data }) => readVersionSources(getDb(), env.SOURCES, data));

export const getReplayPage = createServerFn({ method: "GET" })
  .validator(id)
  .handler(({ data }) => getReplayLife(getDb(), data));

export type ReplayData =
  | {
      status: "ok";
      /** Encoded `ReplayChunk`, base64. */
      chunk: string;
      participants: Participant[];
    }
  | { status: "missing" };

/** The recorded chunk of a life and who played in it. Fetched by the page after it loads. */
export const getReplayData = createServerFn({ method: "GET" })
  .validator(id)
  .handler(async ({ data }): Promise<ReplayData> => {
    const db = getDb();
    const [life, key] = await Promise.all([getReplayLife(db, data), getReplayKey(db, data)]);
    if (!life || !key) return { status: "missing" };
    const object = await env.REPLAYS.get(key);
    if (!object) return { status: "missing" };
    const bytes = new Uint8Array(await object.arrayBuffer());
    let range: { startTick: number; endTick: number };
    try {
      range = replayChunkInfo(bytes);
    } catch {
      return { status: "missing" };
    }
    return {
      status: "ok",
      chunk: Buffer.from(bytes).toString("base64"),
      participants: await getParticipants(db, life.room, range.startTick, range.endTick),
    };
  });
