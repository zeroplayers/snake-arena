/**
 * Usernames are claimed once, right after the first GitHub sign-in, and never change (they're in
 * every URL). `/update-user` is disabled, so this endpoint is the only way to set one.
 */
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { and, eq, isNull } from "drizzle-orm";
import * as z from "zod";
import type { Db } from "../db";
import { users } from "../db/schema";

export const USERNAME_MIN = 2;
export const USERNAME_MAX = 39;
export const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/i;

/** Route-like or confusing names nobody gets to own. */
export const RESERVED_USERNAMES = new Set([
  "admin",
  "api",
  "arena",
  "device",
  "docs",
  "help",
  "house",
  "leaderboard",
  "login",
  "logout",
  "mcp",
  "me",
  "null",
  "root",
  "settings",
  "staff",
  "support",
  "system",
  "undefined",
  "welcome",
  "zerosnake",
]);

export function isValidUsername(name: string) {
  return (
    name.length >= USERNAME_MIN &&
    name.length <= USERNAME_MAX &&
    USERNAME_PATTERN.test(name) &&
    !RESERVED_USERNAMES.has(name.toLowerCase())
  );
}

export const usernameClaim = (db: Db) =>
  ({
    id: "username-claim",
    endpoints: {
      claimUsername: createAuthEndpoint(
        "/username/claim",
        { method: "POST", body: z.object({ username: z.string() }), use: [sessionMiddleware] },
        async (ctx) => {
          const { username } = ctx.body;
          if (!isValidUsername(username)) {
            throw new APIError("BAD_REQUEST", {
              code: "INVALID_USERNAME",
              message: `Use ${USERNAME_MIN}–${USERNAME_MAX} letters, digits, - or _, not starting or ending with - or _`,
            });
          }
          const userId = ctx.context.session.user.id;
          let claimed: { id: string }[];
          try {
            // Conditional, so two racing claims can't both win.
            claimed = await db
              .update(users)
              .set({ username: username.toLowerCase(), displayUsername: username })
              .where(and(eq(users.id, userId), isNull(users.username)))
              .returning({ id: users.id });
          } catch (error) {
            if (String((error as Error).cause ?? error).includes("UNIQUE")) {
              throw new APIError("BAD_REQUEST", {
                code: "USERNAME_IS_ALREADY_TAKEN",
                message: "That username is taken",
              });
            }
            throw error;
          }
          if (claimed.length === 0) {
            throw new APIError("BAD_REQUEST", {
              code: "USERNAME_ALREADY_SET",
              message: "Your username is already set and can't be changed",
            });
          }
          return ctx.json({ username: username.toLowerCase() });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
