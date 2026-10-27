/**
 * Server functions for the public pages (leaderboard, bot page, replay). Read-only; each
 * validates its input and goes through a query module. The replay player's chunk comes from
 * `GET /api/lives/:id/replay` (`src/server/replay-api.ts`), which can answer 410.
 */

import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getLeaderboard, RANKED_MIN_LIVES } from "../db/queries";
import { getBotPage } from "../queries/bot";
import { getReplayLife } from "../queries/replay";
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
