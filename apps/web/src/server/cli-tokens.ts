/**
 * CLI tokens are the sessions the device flow issues to `zerosnake login` (`kind = 'cli'`). This
 * plugin lists them without exposing the token itself and revokes them by id, for the settings
 * page and, later, `zerosnake logout`.
 */
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import * as z from "zod";
import type { SessionKind } from "../db/schema";

export interface CliToken {
  id: string;
  createdAt: Date;
  /** Bumped when the session is refreshed, roughly "last used". */
  updatedAt: Date;
  expiresAt: Date;
  userAgent: string | null;
  ipAddress: string | null;
  /** The request was made with this token. */
  current: boolean;
}

type StoredSession = {
  id: string;
  token: string;
  kind?: SessionKind;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  userAgent?: string | null;
  ipAddress?: string | null;
};

export const cliTokens = () =>
  ({
    id: "cli-tokens",
    endpoints: {
      listCliTokens: createAuthEndpoint(
        "/cli-tokens/list",
        { method: "GET", use: [sessionMiddleware] },
        async (ctx) => {
          const { session } = ctx.context.session;
          const all = (await ctx.context.internalAdapter.listSessions(session.userId, {
            onlyActiveSessions: true,
          })) as StoredSession[];
          const tokens: CliToken[] = all
            .filter((s) => s.kind === "cli")
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .map((s) => ({
              id: s.id,
              createdAt: s.createdAt,
              updatedAt: s.updatedAt,
              expiresAt: s.expiresAt,
              userAgent: s.userAgent ?? null,
              ipAddress: s.ipAddress ?? null,
              current: s.id === session.id,
            }));
          return ctx.json(tokens);
        },
      ),
      revokeCliToken: createAuthEndpoint(
        "/cli-tokens/revoke",
        { method: "POST", body: z.object({ id: z.string() }), use: [sessionMiddleware] },
        async (ctx) => {
          const { session } = ctx.context.session;
          const all = (await ctx.context.internalAdapter.listSessions(
            session.userId,
          )) as StoredSession[];
          const target = all.find((s) => s.id === ctx.body.id && s.kind === "cli");
          if (!target) throw new APIError("NOT_FOUND", { message: "No such CLI token" });
          await ctx.context.internalAdapter.deleteSession(target.token);
          return ctx.json({ status: true });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
