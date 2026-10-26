import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { bearer, deviceAuthorization, username } from "better-auth/plugins";
import { createDb } from "../db";
import { authSchema } from "../db/schema";
import { cliTokens } from "./cli-tokens";

export interface AuthEnv {
  DB: D1Database;
  /** Public origin, e.g. `https://arena.surninsynergy.dev`. */
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

/** `client_id` the CLI sends to the device flow. */
export const CLI_CLIENT_ID = "zerosnake-cli";

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
  return USERNAME_PATTERN.test(name) && !RESERVED_USERNAMES.has(name.toLowerCase());
}

const DAY = 60 * 60 * 24;

/**
 * Rules Better Auth has no option for: the username is chosen once and then fixed (it's in every
 * URL), `githubLogin` only comes from GitHub, and the CLI can't be signed in before the user has
 * a username.
 */
const guards = createAuthMiddleware(async (ctx) => {
  if (ctx.path === "/update-user") {
    const body = (ctx.body ?? {}) as { username?: unknown; githubLogin?: unknown };
    if (body.githubLogin !== undefined) {
      throw new APIError("BAD_REQUEST", { message: "githubLogin can't be changed" });
    }
    if (typeof body.username === "string") {
      const current = (await getSessionFromCtx(ctx))?.user as { username?: string | null };
      if (current?.username && current.username !== body.username.toLowerCase()) {
        throw new APIError("BAD_REQUEST", { message: "Username can't be changed" });
      }
    }
  }
  if (ctx.path === "/device/approve") {
    const user = (await getSessionFromCtx(ctx))?.user as { username?: string | null } | undefined;
    if (user && !user.username) {
      throw new APIError("FORBIDDEN", { message: "Choose a username before signing in the CLI" });
    }
  }
});

export function createAuth(env: AuthEnv) {
  for (const key of ["BETTER_AUTH_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"] as const) {
    if (!env[key]) throw new Error(`${key} is not set (see apps/web/.dev.vars.example)`);
  }

  return betterAuth({
    appName: "ZeroSnake Arena",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(createDb(env.DB), {
      provider: "sqlite",
      schema: authSchema,
      usePlural: true,
    }),
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        mapProfileToUser: (profile) => ({ githubLogin: profile.login }),
      },
    },
    user: {
      additionalFields: {
        // Settable from the GitHub profile only; `/update-user` rejects it (see `guards`).
        githubLogin: { type: "string", required: false },
      },
    },
    session: {
      // Web sessions and CLI tokens alike slide forward while in use.
      expiresIn: 30 * DAY,
      updateAge: DAY,
      additionalFields: {
        kind: { type: "string", required: false, input: false, defaultValue: "web" },
      },
    },
    databaseHooks: {
      session: {
        create: {
          // The device flow's token endpoint is the only place CLI tokens are minted.
          before: async (session, ctx) =>
            ctx?.path === "/device/token" ? { data: { ...session, kind: "cli" } } : undefined,
        },
      },
    },
    hooks: { before: guards },
    plugins: [
      username({
        minUsernameLength: 2,
        maxUsernameLength: 39,
        usernameValidator: isValidUsername,
      }),
      deviceAuthorization({
        verificationUri: "/device",
        expiresIn: "10m",
        validateClient: (clientId) => clientId === CLI_CLIENT_ID,
      }),
      // `Authorization: Bearer <token>` from the CLI.
      bearer(),
      cliTokens(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type AuthSession = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;
