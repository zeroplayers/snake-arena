/**
 * Server functions behind `/bots` (bot management). Thin wrappers: the rules, the session check
 * and the same-origin check are in `bot-admin.ts`. Every function returns an `AdminResult`, so
 * the page can show the message as is.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { getBotAdmin } from "./env";

const id = z.string().min(1).max(128);
const name = z.string().max(200);

export const getManagePage = createServerFn({ method: "GET" }).handler(() =>
  getBotAdmin().overview(getRequest()),
);

export const getOlderVersions = createServerFn({ method: "GET" })
  .validator(
    z.object({
      botId: id,
      before: z.number().int().min(1),
      limit: z.number().int().min(1).max(500).optional(),
    }),
  )
  .handler(({ data }) => getBotAdmin().olderVersions(getRequest(), data));

export const createBot = createServerFn({ method: "POST" })
  .validator(z.object({ name, slug: z.string().max(64).optional() }))
  .handler(({ data }) => getBotAdmin().createBot(getRequest(), data));

export const renameBot = createServerFn({ method: "POST" })
  .validator(z.object({ botId: id, name }))
  .handler(({ data }) => getBotAdmin().renameBot(getRequest(), data));

export const archiveBot = createServerFn({ method: "POST" })
  .validator(z.object({ botId: id }))
  .handler(({ data }) => getBotAdmin().archiveBot(getRequest(), data));

export const restoreBot = createServerFn({ method: "POST" })
  .validator(z.object({ botId: id }))
  .handler(({ data }) => getBotAdmin().restoreBot(getRequest(), data));

export const activateVersion = createServerFn({ method: "POST" })
  .validator(z.object({ versionId: id }))
  .handler(({ data }) => getBotAdmin().activateVersion(getRequest(), data));

export const archiveVersion = createServerFn({ method: "POST" })
  .validator(z.object({ versionId: id }))
  .handler(({ data }) => getBotAdmin().archiveVersion(getRequest(), data));
