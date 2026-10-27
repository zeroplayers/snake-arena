/**
 * Where Better Auth keeps web sessions: Workers KV (`AUTH_KV`), bound only to this Worker.
 *
 * Better Auth stores session tokens in plaintext, and D1 is shared with apps/arena, which runs
 * untrusted bot code. So sessions go to Better Auth's `secondaryStorage` with
 * `session.storeSessionInDatabase: false` and never touch D1 (issue #50).
 *
 * What Better Auth puts here, all with a TTL that ends with the session:
 * - `<token>` → `{ session, user }`;
 * - `active-sessions-<userId>` → the user's tokens, for sign-out everywhere.
 *
 * KV is eventually consistent: another location can serve a deleted session for a minute or so,
 * and the `active-sessions-` list, rewritten on every sign-in, can miss tokens. A session read
 * there could even be written back by Better Auth's daily refresh, alive for another 30 days.
 * So revocation is decided in D1, which every read here checks anyway:
 * - a signed-out token's SHA-256 goes to `revoked_sessions` (a hash is no usable token) before the
 *   KV entry is deleted;
 * - `/revoke-sessions` sets `users.sessions_revoked_at` (`recordRevokeAll`), which ends every
 *   session created before it, listed or not.
 * A revoked session reads as missing and is never written back.
 *
 * Two more departures from a plain key-value store:
 * - The `user` cached next to a session is re-read from D1 on every read. Usernames
 *   (`/username/claim`) and bans (src/server/moderation.ts) are written to D1 directly, and the
 *   copy Better Auth cached at sign-in would otherwise keep a stale username or miss a ban.
 *   With the revocation check, that is one D1 read per session check, as before sessions moved.
 * - `verification:*` keys are not stored: KV can't consume a value atomically, so verification
 *   values (OAuth state) stay in D1 (`verification.storeInDatabase`), with no second copy here.
 */
import { log } from "@zerosnake/observability";
import type { SecondaryStorage } from "better-auth";
import { eq, lt, sql } from "drizzle-orm";
import type { Db } from "../db";
import { revokedSessions, users } from "../db/schema";
import { hashToken } from "./cli-auth";

/** KV's minimum `expirationTtl`, in seconds. */
export const KV_MIN_TTL = 60;

const VERIFICATION_PREFIX = "verification:";
const ACTIVE_SESSIONS_PREFIX = "active-sessions-";

interface CachedSession {
  session: { createdAt: string | number | Date };
  user: { id: string };
}

function parseCachedSession(raw: string): CachedSession | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { session, user } = value as Partial<CachedSession>;
  return typeof session === "object" && session !== null && typeof user?.id === "string"
    ? (value as CachedSession)
    : null;
}

export interface SessionStoreOptions {
  /** Better Auth's `session.expiresIn`, in seconds: how long a revoked token must stay listed. */
  sessionTtl: number;
}

export function kvSessionStore(
  kv: KVNamespace,
  db: Db,
  { sessionTtl }: SessionStoreOptions,
): SecondaryStorage {
  /** The session's user, fresh from D1, or `null` if the user is gone or the session revoked. */
  async function liveUser(token: string, cached: CachedSession) {
    const tokenHash = await hashToken(token);
    const row = await db
      .select({
        user: users,
        revoked: sql<number>`exists (select 1 from ${revokedSessions} where ${revokedSessions.tokenHash} = ${tokenHash})`,
      })
      .from(users)
      .where(eq(users.id, cached.user.id))
      .get();
    if (!row || row.revoked) return null;
    const { sessionsRevokedAt } = row.user;
    if (sessionsRevokedAt && new Date(cached.session.createdAt) <= sessionsRevokedAt) return null;
    return row.user;
  }

  return {
    async get(key) {
      if (key.startsWith(VERIFICATION_PREFIX)) return null;
      const raw = await kv.get(key);
      if (raw === null) return null;
      const cached = parseCachedSession(raw);
      if (!cached) return raw;
      const user = await liveUser(key, cached);
      return user ? JSON.stringify({ ...cached, user }) : null;
    },
    async set(key, value, ttl) {
      if (key.startsWith(VERIFICATION_PREFIX)) return;
      const cached = parseCachedSession(value);
      // A refresh of a session read from a stale copy must not bring it back.
      if (cached && !(await liveUser(key, cached))) return;
      try {
        // Better Auth passes the seconds left; KV wants at least a minute. Expiry is still exact:
        // Better Auth checks `expiresAt` on every read.
        await kv.put(key, value, { expirationTtl: Math.max(ttl ?? 0, KV_MIN_TTL) });
      } catch (error) {
        // KV takes one write per second per key. Losing a refresh or an `active-sessions-` update
        // costs nothing (revocation is in D1), and must not fail the request. A new session's key
        // has never been written, so its first write can't hit this.
        if (!/\b429\b/.test(String(error))) throw error;
        log("warn", "auth.kv_write_limited", {
          key: key.startsWith(ACTIVE_SESSIONS_PREFIX) ? "active-sessions" : "session",
        });
      }
    },
    async delete(key) {
      if (key.startsWith(VERIFICATION_PREFIX)) return;
      if (!key.startsWith(ACTIVE_SESSIONS_PREFIX)) {
        // A session token. Revoked in D1 first: KV may serve it a while longer elsewhere.
        await db
          .insert(revokedSessions)
          .values({
            tokenHash: await hashToken(key),
            expiresAt: new Date(Date.now() + sessionTtl * 1000),
          })
          .onConflictDoNothing();
      }
      await kv.delete(key);
    },
    // Only verification consumption and Better Auth's rate limiter use these, and neither runs
    // here (verification values stay in D1, `rateLimit` is off).
    async getAndDelete() {
      throw new Error("AUTH_KV can't get and delete atomically");
    },
    async increment() {
      throw new Error("AUTH_KV can't increment atomically");
    },
  };
}

/** Ends every web session of `userId` created up to `now`, wherever KV still has it. */
export async function revokeAllSessions(db: Db, userId: string, now = new Date()) {
  await db.update(users).set({ sessionsRevokedAt: now }).where(eq(users.id, userId));
}

/** Forgets revoked tokens that would have expired by now anyway (5-minute cron). */
export async function pruneRevokedSessions(db: Db, now = new Date()) {
  await db.delete(revokedSessions).where(lt(revokedSessions.expiresAt, now));
}
