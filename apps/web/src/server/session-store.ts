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
 * Two departures from a plain key-value store:
 * - The `user` cached next to a session is re-read from D1 on every read. Usernames
 *   (`/username/claim`) and bans (src/server/moderation.ts) are written to D1 directly, and the
 *   copy Better Auth cached at sign-in would otherwise keep a stale username or miss a ban.
 *   That is one D1 read per session check, as before sessions moved.
 * - `verification:*` keys are not stored: KV can't consume a value atomically, so verification
 *   values (OAuth state) stay in D1 (`verification.storeInDatabase`), with no second copy here.
 *
 * KV is eventually consistent: a sign-out is visible at once where it happened and within about
 * a minute everywhere else.
 */
import type { SecondaryStorage } from "better-auth";
import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { users } from "../db/schema";

/** KV's minimum `expirationTtl`, in seconds. */
export const KV_MIN_TTL = 60;

const VERIFICATION_PREFIX = "verification:";

interface CachedSession {
  session: unknown;
  user: { id: string };
}

function isCachedSession(value: unknown): value is CachedSession {
  if (typeof value !== "object" || value === null) return false;
  const { session, user } = value as Partial<CachedSession>;
  return typeof session === "object" && typeof user?.id === "string";
}

export function kvSessionStore(kv: KVNamespace, db: Db): SecondaryStorage {
  return {
    async get(key) {
      if (key.startsWith(VERIFICATION_PREFIX)) return null;
      const raw = await kv.get(key);
      if (raw === null) return null;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        return raw;
      }
      if (!isCachedSession(value)) return raw;
      const user = await db.select().from(users).where(eq(users.id, value.user.id)).get();
      // The user is gone: so is the session.
      if (!user) return null;
      return JSON.stringify({ ...value, user });
    },
    async set(key, value, ttl) {
      if (key.startsWith(VERIFICATION_PREFIX)) return;
      // Better Auth passes the seconds left; KV wants at least a minute. Expiry is still exact:
      // Better Auth checks `expiresAt` on every read.
      await kv.put(key, value, ttl ? { expirationTtl: Math.max(ttl, KV_MIN_TTL) } : undefined);
    },
    async delete(key) {
      if (key.startsWith(VERIFICATION_PREFIX)) return;
      await kv.delete(key);
    },
    // Only verification consumption and Better Auth's rate limiter use these, and neither runs
    // here (verification values stay in D1, `rateLimit` is off).
    getAndDelete() {
      throw new Error("AUTH_KV can't get and delete atomically");
    },
    increment() {
      throw new Error("AUTH_KV can't increment atomically");
    },
  };
}
