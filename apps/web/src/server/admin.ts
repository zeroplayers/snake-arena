/**
 * Server functions behind `/admin`. Thin wrappers: who is an admin, the session check and the
 * same-origin check are in `moderation.ts`. Every function returns a `ModerationResult`.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { getModeration } from "./env";

const target = z.string().min(1).max(500);
const reason = z.string().max(1000);
const toggle = z.object({ paused: z.boolean(), reason });

export const getAdminPage = createServerFn({ method: "GET" }).handler(() =>
  getModeration().overview(getRequest()),
);

export const setArenaPaused = createServerFn({ method: "POST" })
  .validator(toggle)
  .handler(({ data }) => getModeration().setArenaPaused(getRequest(), data));

export const setDeploysPaused = createServerFn({ method: "POST" })
  .validator(toggle)
  .handler(({ data }) => getModeration().setDeploysPaused(getRequest(), data));

export const banUser = createServerFn({ method: "POST" })
  .validator(z.object({ user: target, reason }))
  .handler(({ data }) => getModeration().banUser(getRequest(), data));

export const unbanUser = createServerFn({ method: "POST" })
  .validator(z.object({ user: target, reason }))
  .handler(({ data }) => getModeration().unbanUser(getRequest(), data));

export const banBot = createServerFn({ method: "POST" })
  .validator(z.object({ bot: target, reason }))
  .handler(({ data }) => getModeration().banBot(getRequest(), data));

export const unbanBot = createServerFn({ method: "POST" })
  .validator(z.object({ bot: target, reason }))
  .handler(({ data }) => getModeration().unbanBot(getRequest(), data));

export const banVersion = createServerFn({ method: "POST" })
  .validator(z.object({ version: target, reason }))
  .handler(({ data }) => getModeration().banVersion(getRequest(), data));
