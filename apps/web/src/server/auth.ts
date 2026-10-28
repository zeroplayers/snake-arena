import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { deviceAuthorization } from "better-auth/plugins";
import { createDb, type Db } from "../db";
import { authSchema } from "../db/schema";
import { CLI_CLIENT_ID, cliAuth } from "./cli-auth";
import { kvSessionStore, revokeAllSessions } from "./session-store";
import { usernameClaim } from "./username";

export { CLI_CLIENT_ID } from "./cli-auth";
export { isValidUsername } from "./username";

export interface AuthEnv {
  DB: D1Database;
  /** Web sessions (src/server/session-store.ts). Bound to this Worker only, never to apps/arena. */
  AUTH_KV: KVNamespace;
  /** Public origin, e.g. `https://staging.zerosnake.dev`. */
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

const DAY = 60 * 60 * 24;
const SESSION_TTL = 30 * DAY;

/**
 * Endpoints Better Auth adds that we don't want reachable over HTTP:
 * - `/update-user` would let people rewrite `image`/`name` (rendered on profiles) and the
 *   username; usernames go through `/username/claim`, the rest comes from GitHub.
 * - `/list-sessions` returns the raw token of every session.
 * - `/device/token` mints a full session; the CLI uses `/cli/token` instead (see cli-auth.ts).
 * - `/revoke-other-sessions` revokes only what KV's eventually consistent `active-sessions-` list
 *   names, so it can miss some; `/revoke-sessions` ends all of them (see session-store.ts).
 */
const DISABLED_PATHS = [
  "/update-user",
  "/list-sessions",
  "/device/token",
  "/revoke-other-sessions",
];

/** The CLI can't be signed in before the user has a username, nor by a banned user. */
const requireUsernameToApproveDevice = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/device/approve") return;
  const user = (await getSessionFromCtx(ctx))?.user as
    | { username?: string | null; bannedAt?: Date | null }
    | undefined;
  if (user?.bannedAt) {
    throw new APIError("FORBIDDEN", { message: "Your account is suspended" });
  }
  if (user && !user.username) {
    throw new APIError("FORBIDDEN", { message: "Choose a username before signing in the CLI" });
  }
});

/**
 * After `/revoke-sessions` ("sign out everywhere"), every session created until now is revoked in
 * D1, including any KV still serves or the `active-sessions-` list missed (session-store.ts).
 * After, not before: before it, the endpoint's own session check would already fail.
 */
const recordRevokeAll = (db: Db) =>
  createAuthMiddleware(async (ctx) => {
    if (ctx.path !== "/revoke-sessions") return;
    const userId = ctx.context.session?.user.id;
    if (userId && !(ctx.context.returned instanceof APIError)) await revokeAllSessions(db, userId);
  });

export function createAuth(env: AuthEnv) {
  for (const key of ["BETTER_AUTH_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"] as const) {
    if (!env[key]) throw new Error(`${key} is not set (see apps/web/.dev.vars.example)`);
  }
  // Without it Better Auth would quietly fall back to session rows in the shared D1.
  if (!env.AUTH_KV) throw new Error("AUTH_KV is not bound (see apps/web/wrangler.jsonc)");
  const db = createDb(env.DB);

  return betterAuth({
    appName: "ZeroSnake Arena",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "sqlite", schema: authSchema, usePlural: true }),
    // Web sessions live in KV, not in D1, which apps/arena (untrusted bot code) can read.
    secondaryStorage: kvSessionStore(env.AUTH_KV, db, { sessionTtl: SESSION_TTL }),
    disabledPaths: DISABLED_PATHS,
    // Better Auth skips the origin/CSRF check when it detects a test runner; keep it on so tests
    // exercise what production does.
    advanced: { disableOriginCheck: false },
    // Its limiter counts in memory, per isolate, so on Workers it limits almost nothing. The
    // shared limiter in front of `/api/auth/*` (src/server/edge.ts, rate-limit.ts) replaces it.
    rateLimit: { enabled: false },
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        mapProfileToUser: (profile) => ({ githubLogin: profile.login }),
      },
    },
    user: {
      additionalFields: {
        // Set by `/username/claim` only.
        username: { type: "string", required: false, input: false },
        displayUsername: { type: "string", required: false, input: false },
        // From the GitHub profile; suggests a username. `input: true` because Better Auth drops
        // non-input fields from provider profiles; `/update-user` is disabled anyway.
        githubLogin: { type: "string", required: false },
        // Set by admins only (src/server/moderation.ts).
        bannedAt: { type: "date", required: false, input: false },
        banReason: { type: "string", required: false, input: false },
      },
    },
    account: {
      // GitHub access tokens at rest, since apps/arena shares this database.
      encryptOAuthTokens: true,
    },
    session: {
      expiresIn: SESSION_TTL,
      updateAge: DAY,
      storeSessionInDatabase: false,
    },
    // OAuth state: single-use, which KV can't enforce (see session-store.ts).
    verification: { storeInDatabase: true },
    hooks: { before: requireUsernameToApproveDevice, after: recordRevokeAll(db) },
    plugins: [
      deviceAuthorization({
        verificationUri: "/device",
        expiresIn: "10m",
        validateClient: (clientId) => clientId === CLI_CLIENT_ID,
      }),
      usernameClaim(db),
      cliAuth(db),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type AuthSession = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;
