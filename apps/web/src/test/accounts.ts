/**
 * Real Better Auth accounts for tests: a (fake) GitHub sign-in that leaves a web session
 * cookie, then a username claim.
 */
import { expect, vi } from "vitest";
import type { Auth } from "../server/auth";
import { CookieJar, mockGithub } from "./github";

export interface TestAccount {
  id: string;
  login: string;
  githubId: number;
  jar: CookieJar;
}

export async function signUp(
  auth: Auth,
  db: D1Database,
  base: string,
  login: string,
  githubId: number,
): Promise<TestAccount> {
  mockGithub({ id: githubId, login, name: login, email: `${login}@example.com` });
  const jar = new CookieJar();
  const start = await auth.handler(
    new Request(`${base}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ provider: "github", callbackURL: "/welcome" }),
    }),
  );
  jar.store(start);
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state");
  jar.store(
    await auth.handler(
      new Request(`${base}/api/auth/callback/github?code=c&state=${state}`, {
        headers: { cookie: jar.header() },
      }),
    ),
  );
  const claim = await auth.handler(
    new Request(`${base}/api/auth/username/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, cookie: jar.header() },
      body: JSON.stringify({ username: login }),
    }),
  );
  expect(claim.status).toBe(200);
  const row = await db
    .prepare("SELECT id FROM users WHERE username = ?")
    .bind(login)
    .first<{ id: string }>();
  if (!row) throw new Error("sign-up failed");
  vi.unstubAllGlobals();
  return { id: row.id, login, githubId, jar };
}

export interface WebSession {
  token: string;
  userId: string;
  /** KV expiration, seconds since the epoch. */
  expiration: number | undefined;
}

/** The web sessions Better Auth keeps in `AUTH_KV` (src/server/session-store.ts). */
export async function webSessions(kv: KVNamespace): Promise<WebSession[]> {
  const { keys } = await kv.list();
  const sessions: WebSession[] = [];
  for (const { name, expiration } of keys) {
    if (name.startsWith("active-sessions-")) continue;
    const value = await kv.get<{ session?: { userId: string } }>(name, "json");
    if (value?.session) sessions.push({ token: name, userId: value.session.userId, expiration });
  }
  return sessions;
}
