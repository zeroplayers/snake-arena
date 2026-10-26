/**
 * CLI authentication for `zerosnake login`.
 *
 * The device flow (Better Auth's deviceAuthorization plugin) is reused up to approval, but the
 * token endpoint is ours: instead of a Better Auth session it mints an opaque bearer token and
 * stores only its SHA-256 in `cli_tokens`. So a CLI token
 * - can't call any Better Auth endpoint (it isn't a session, and there is no `bearer()` plugin),
 *   so a leaked one can't read other sessions, approve devices or change the account;
 * - is useless to whoever reads the database (also bound to apps/arena, which runs bot code).
 *
 * Routes that act for the CLI (the deploy API) call `authenticateCli()`.
 */
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, getIP, sessionMiddleware } from "better-auth/api";
import { redeemDeviceCode } from "better-auth/plugins/device-authorization";
import { and, desc, eq, gt } from "drizzle-orm";
import * as z from "zod";
import type { Db } from "../db";
import { cliTokens, users } from "../db/schema";

/** `client_id` the CLI sends to the device flow. */
export const CLI_CLIENT_ID = "zerosnake-cli";

const TOKEN_PREFIX = "zsk_";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Tokens expire after 90 days without use. */
const TOKEN_TTL_MS = 90 * DAY_MS;

export interface CliToken {
  id: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  userAgent: string | null;
  ipAddress: string | null;
}

export interface CliIdentity {
  tokenId: string;
  user: { id: string; username: string | null; name: string; image: string | null };
}

export async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function generateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return (
    TOKEN_PREFIX +
    btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, (c) =>
      c === "+" ? "-" : c === "/" ? "_" : "",
    )
  );
}

function bearerToken(headers: Headers) {
  const token = /^bearer\s+(\S+)\s*$/i.exec(headers.get("authorization") ?? "")?.[1];
  return token?.startsWith(TOKEN_PREFIX) ? token : null;
}

/** Resolves `Authorization: Bearer zsk_…` to its user, or `null`. Slides the expiry daily. */
export async function authenticateCli(db: Db, headers: Headers): Promise<CliIdentity | null> {
  const token = bearerToken(headers);
  if (!token) return null;
  const now = new Date();
  const [row] = await db
    .select({
      tokenId: cliTokens.id,
      lastUsedAt: cliTokens.lastUsedAt,
      user: { id: users.id, username: users.username, name: users.name, image: users.image },
    })
    .from(cliTokens)
    .innerJoin(users, eq(users.id, cliTokens.userId))
    .where(and(eq(cliTokens.tokenHash, await hashToken(token)), gt(cliTokens.expiresAt, now)))
    .limit(1);
  if (!row) return null;
  if (now.getTime() - row.lastUsedAt.getTime() > DAY_MS) {
    await db
      .update(cliTokens)
      .set({ lastUsedAt: now, expiresAt: new Date(now.getTime() + TOKEN_TTL_MS) })
      .where(eq(cliTokens.id, row.tokenId));
  }
  return { tokenId: row.tokenId, user: row.user };
}

const deviceTokenBody = z.object({
  grant_type: z.literal("urn:ietf:params:oauth:grant-type:device_code"),
  device_code: z.string(),
  client_id: z.string(),
});

export const cliAuth = (db: Db) =>
  ({
    id: "cli-auth",
    endpoints: {
      /** RFC 8628 token endpoint; replaces the plugin's `/device/token` (disabled). */
      cliToken: createAuthEndpoint(
        "/cli/token",
        { method: "POST", body: deviceTokenBody },
        async (ctx) => {
          const { device_code, client_id } = ctx.body;
          if (client_id !== CLI_CLIENT_ID) {
            throw new APIError("BAD_REQUEST", {
              error: "invalid_client",
              error_description: "Unknown client",
            });
          }
          const { user } = await redeemDeviceCode({
            ctx,
            deviceCode: device_code,
            authorizeRedemption: (record) => {
              if (record.clientId && record.clientId !== client_id) {
                throw new APIError("BAD_REQUEST", {
                  error: "invalid_grant",
                  error_description: "Client ID mismatch",
                });
              }
              return {
                ownershipWhere: { field: "clientId", value: client_id },
                context: undefined,
              };
            },
            prepareRedemption: () => undefined,
          });

          const token = generateToken();
          const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
          await db.insert(cliTokens).values({
            userId: user.id,
            tokenHash: await hashToken(token),
            userAgent: ctx.headers?.get("user-agent") ?? null,
            ipAddress: (ctx.request && getIP(ctx.request, ctx.context.options)) || null,
            expiresAt,
          });
          ctx.setHeader("Cache-Control", "no-store");
          ctx.setHeader("Pragma", "no-cache");
          return ctx.json({
            access_token: token,
            token_type: "Bearer",
            expires_in: Math.floor(TOKEN_TTL_MS / 1000),
            scope: "",
          });
        },
      ),

      /** Who the CLI is signed in as (`zerosnake whoami`). */
      cliMe: createAuthEndpoint("/cli/me", { method: "GET" }, async (ctx) => {
        const identity = ctx.headers && (await authenticateCli(db, ctx.headers));
        if (!identity) throw new APIError("UNAUTHORIZED", { message: "Invalid CLI token" });
        return ctx.json(identity);
      }),

      /** Revokes the calling token (`zerosnake logout`). */
      cliLogout: createAuthEndpoint("/cli/logout", { method: "POST" }, async (ctx) => {
        const identity = ctx.headers && (await authenticateCli(db, ctx.headers));
        if (!identity) throw new APIError("UNAUTHORIZED", { message: "Invalid CLI token" });
        await db.delete(cliTokens).where(eq(cliTokens.id, identity.tokenId));
        return ctx.json({ status: true });
      }),

      /** Settings page: the signed-in user's CLI tokens, never the tokens themselves. */
      listCliTokens: createAuthEndpoint(
        "/cli/tokens",
        { method: "GET", use: [sessionMiddleware] },
        async (ctx) => {
          const tokens: CliToken[] = await db
            .select({
              id: cliTokens.id,
              createdAt: cliTokens.createdAt,
              lastUsedAt: cliTokens.lastUsedAt,
              expiresAt: cliTokens.expiresAt,
              userAgent: cliTokens.userAgent,
              ipAddress: cliTokens.ipAddress,
            })
            .from(cliTokens)
            .where(
              and(
                eq(cliTokens.userId, ctx.context.session.user.id),
                gt(cliTokens.expiresAt, new Date()),
              ),
            )
            .orderBy(desc(cliTokens.createdAt));
          return ctx.json(tokens);
        },
      ),

      revokeCliToken: createAuthEndpoint(
        "/cli/tokens/revoke",
        { method: "POST", body: z.object({ id: z.string() }), use: [sessionMiddleware] },
        async (ctx) => {
          const deleted = await db
            .delete(cliTokens)
            .where(
              and(eq(cliTokens.id, ctx.body.id), eq(cliTokens.userId, ctx.context.session.user.id)),
            )
            .returning({ id: cliTokens.id });
          if (deleted.length === 0)
            throw new APIError("NOT_FOUND", { message: "No such CLI token" });
          return ctx.json({ status: true });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
