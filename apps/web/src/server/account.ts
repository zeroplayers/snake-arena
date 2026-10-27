/**
 * The user's data rights on `/settings` (GDPR, CCPA): download everything we hold about them,
 * and delete the account. Only web sessions get in (like `bot-admin.ts`), and the deletion must
 * come from the site's own origin.
 *
 * - `GET /api/account/export`: one JSON file, streamed (lives are paged): the profile, the
 *   linked GitHub account (no tokens), web sessions and CLI tokens (no secrets), bots, versions
 *   with their ratings and links to download each bundle and source archive, activations and
 *   every life. Traces (7 days, owner only) are linked from the replay pages rather than copied.
 * - `GET /api/account/files/:versionId/:kind`: a version's `bundle` or `source`, owner only.
 * - `POST /api/account/delete` `{ confirm: <username> }`: step 1 of the deletion
 *   (`src/shared/account.ts`), then the KV session entries go. The cron (`purgeDeletedAccounts`)
 *   erases the rest.
 */
import { log } from "@zerosnake/observability";
import { and, asc, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import { createDb } from "../db";
import {
  accounts,
  activations,
  bots,
  cliTokens,
  deviceCodes,
  heldUsernames,
  lives,
  ratings,
  users,
  verifications,
  versions,
} from "../db/schema";
import {
  ACCOUNT_PURGE_AFTER_MS,
  DELETE_ACCOUNT_STATEMENTS,
  DELETE_ACCOUNT_STOPPED,
  deleteAccountParams,
  PURGE_SQL,
} from "../shared/account";
import { ACTIVE_VERSION_CHANGE_VERSION, type ActiveVersionChange } from "../shared/arena";
import { TRACE_RETENTION_DAYS } from "../shared/trace";
import { hashToken } from "./cli-auth";
import { noRateLimit, type RateLimiter, rateLimitedResponse } from "./rate-limit";
import { setRequestOutcome, setRequestUser } from "./request-context";

export const ACCOUNT_EXPORT_FORMAT = "zerosnake-account-export@1";

/** How long a deleted account's username can't be claimed by anyone else. */
export const USERNAME_HOLD_MS = 30 * 24 * 60 * 60_000;

/** Lives read per D1 query while streaming the export. */
const EXPORT_PAGE = 1000;

export interface AccountEnv {
  DB: D1Database;
  AUTH_KV: KVNamespace;
  BUNDLES: R2Bucket;
  SOURCES: R2Bucket;
  TRACES: R2Bucket;
  /** Public origin (`BETTER_AUTH_URL`); the deletion must come from it, links point at it. */
  BETTER_AUTH_URL: string;
}

interface SessionUser {
  id: string;
  username?: string | null | undefined;
}

export interface AccountOptions {
  getSession(input: { headers: Headers }): Promise<{ user: SessionUser } | null>;
  /** `activeVersionChanged` on the matchmaker, best effort (`matchmakerNotifier`). */
  notify?: (change: ActiveVersionChange) => Promise<void>;
  rateLimiter?: RateLimiter;
  now?: () => Date;
}

export type AccountErrorCode =
  | "unauthorized"
  | "forbidden_origin"
  | "bad_request"
  | "confirmation_mismatch"
  | "not_found";

const STATUS: Record<AccountErrorCode, number> = {
  unauthorized: 401,
  forbidden_origin: 403,
  bad_request: 400,
  confirmation_mismatch: 400,
  not_found: 404,
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

function refuse(error: AccountErrorCode, message: string) {
  setRequestOutcome(error);
  return json({ error, message }, STATUS[error]);
}

/** The web sessions Better Auth listed for `userId` in KV (`active-sessions-<id>`): their tokens. */
async function listedSessionTokens(kv: KVNamespace, userId: string): Promise<string[]> {
  const list = await kv.get<{ token?: unknown }[]>(`active-sessions-${userId}`, "json");
  return Array.isArray(list)
    ? list.flatMap((s) => (typeof s?.token === "string" ? [s.token] : []))
    : [];
}

/** What the user types to confirm the deletion: the username, or a word before they have one. */
export function deleteConfirmation(username: string | null | undefined) {
  return username ? username.toLowerCase() : "delete";
}

export function createAccount(env: AccountEnv, options: AccountOptions) {
  const db = createDb(env.DB);
  const now = options.now ?? (() => new Date());
  const notify = options.notify ?? (async () => {});
  const rateLimiter = options.rateLimiter ?? noRateLimit;
  const siteOrigin = new URL(env.BETTER_AUTH_URL).origin;

  /** The signed-in user, or a refusal. Counts against the user's rate limit. */
  async function signedIn(request: Request): Promise<SessionUser | Response> {
    const session = await options.getSession({ headers: request.headers });
    if (!session) return refuse("unauthorized", "Sign in on the site first.");
    setRequestUser(session.user.id);
    const verdict = await rateLimiter.check("user", session.user.id);
    if (!verdict.ok) {
      setRequestOutcome("rate_limited");
      return rateLimitedResponse(verdict);
    }
    return session.user;
  }

  function sameOrigin(request: Request) {
    const origin = request.headers.get("origin");
    return origin ? origin === siteOrigin : request.headers.get("sec-fetch-site") === "same-origin";
  }

  const fileUrl = (versionId: string, kind: "bundle" | "source") =>
    `${siteOrigin}/api/account/files/${encodeURIComponent(versionId)}/${kind}`;

  /** Everything but the lives, which are streamed after it. */
  async function snapshot(userId: string) {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return null;
    const { sessionsRevokedAt: _, deletedAt: __, purgeFailures: ___, ...profile } = user;
    const [linked, tokens, ownBots, ownActivations, sessions] = await Promise.all([
      db
        .select({
          provider: accounts.providerId,
          accountId: accounts.accountId,
          scope: accounts.scope,
          createdAt: accounts.createdAt,
          updatedAt: accounts.updatedAt,
        })
        .from(accounts)
        .where(eq(accounts.userId, userId)),
      db
        .select({
          id: cliTokens.id,
          userAgent: cliTokens.userAgent,
          ipAddress: cliTokens.ipAddress,
          createdAt: cliTokens.createdAt,
          lastUsedAt: cliTokens.lastUsedAt,
          expiresAt: cliTokens.expiresAt,
        })
        .from(cliTokens)
        .where(eq(cliTokens.userId, userId)),
      db.select().from(bots).where(eq(bots.ownerId, userId)).orderBy(asc(bots.createdAt)),
      db
        .select()
        .from(activations)
        .where(eq(activations.ownerId, userId))
        .orderBy(asc(activations.createdAt)),
      webSessions(userId),
    ]);
    const botIds = ownBots.map((b) => b.id);
    const ownVersions = botIds.length
      ? await db
          .select({ version: versions, rating: ratings })
          .from(versions)
          .leftJoin(ratings, eq(ratings.versionId, versions.id))
          .where(inArray(versions.botId, botIds))
          .orderBy(asc(versions.botId), asc(versions.n))
      : [];
    return {
      profile,
      linkedAccounts: linked,
      webSessions: sessions,
      cliTokens: tokens,
      bots: ownBots.map((bot) => ({
        ...bot,
        url: user.username ? `${siteOrigin}/@${user.username}/${bot.slug}` : null,
        versions: ownVersions
          .filter((r) => r.version.botId === bot.id)
          .map(({ version, rating }) => {
            const {
              bundleKey: _b,
              sourceKey: _s,
              idempotencyKey: _i,
              changeSeq: _c,
              ...v
            } = version;
            return {
              ...v,
              rating: rating ? { mean: rating.mean, ci: rating.ci, nLives: rating.nLives } : null,
              files: {
                bundle: fileUrl(version.id, "bundle"),
                source: fileUrl(version.id, "source"),
              },
            };
          }),
      })),
      activations: ownActivations,
      versionIds: ownVersions.map((r) => r.version.id),
    };
  }

  /** What KV holds about the user's web sessions (when, from where), never the tokens. */
  async function webSessions(userId: string) {
    const out: Record<string, unknown>[] = [];
    for (const token of await listedSessionTokens(env.AUTH_KV, userId)) {
      const value = await env.AUTH_KV.get<{ session?: Record<string, unknown> }>(token, "json");
      const s = value?.session;
      if (!s) continue;
      out.push({
        createdAt: s.createdAt ?? null,
        expiresAt: s.expiresAt ?? null,
        ipAddress: s.ipAddress ?? null,
        userAgent: s.userAgent ?? null,
      });
    }
    return out;
  }

  const lifeColumns = {
    id: lives.id,
    versionId: lives.versionId,
    room: lives.room,
    startTick: lives.startTick,
    endTick: lives.endTick,
    score: lives.score,
    lengthMax: lives.lengthMax,
    kills: lives.kills,
    deathCause: lives.deathCause,
    killer: lives.killer,
    hasReplay: lives.replayKey,
    replayExpiredAt: lives.replayExpiredAt,
    hasTrace: lives.traceKey,
    startedAt: lives.startedAt,
    endedAt: lives.endedAt,
    seq: lives.seq,
  };

  /** A version's lives a page at a time (`lives_version_seq_idx`), unfinished ones first. */
  async function* versionLives(versionId: string) {
    yield await db
      .select(lifeColumns)
      .from(lives)
      .where(and(eq(lives.versionId, versionId), isNull(lives.seq)));
    let after = 0;
    for (;;) {
      const page = await db
        .select(lifeColumns)
        .from(lives)
        .where(and(eq(lives.versionId, versionId), gt(lives.seq, after)))
        .orderBy(asc(lives.seq))
        .limit(EXPORT_PAGE);
      yield page;
      const last = page.at(-1)?.seq;
      if (page.length < EXPORT_PAGE || last == null) return;
      after = last;
    }
  }

  function exportStream(data: NonNullable<Awaited<ReturnType<typeof snapshot>>>) {
    const { versionIds, ...rest } = data;
    const head = JSON.stringify({
      format: ACCOUNT_EXPORT_FORMAT,
      exportedAt: now().toISOString(),
      site: siteOrigin,
      ...rest,
      lives: [],
    });
    const encoder = new TextEncoder();
    // Traces older than this are gone (apps/arena `traces.ts`).
    const traceCutoff = now().getTime() - TRACE_RETENTION_DAYS * 24 * 60 * 60_000;
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          // `...,"lives":[` + rows + `],"complete":true}`. If a read fails midway the stream
          // errors, so the download fails rather than ending early; a file without `complete`
          // was cut short.
          controller.enqueue(encoder.encode(head.slice(0, -2)));
          let first = true;
          for (const versionId of versionIds) {
            for await (const page of versionLives(versionId)) {
              for (const { hasReplay, replayExpiredAt, hasTrace, seq: _, ...life } of page) {
                const row = {
                  ...life,
                  // Expired replays (`src/server/replays.ts`) have nothing left to link to.
                  replay: hasReplay && !replayExpiredAt ? `${siteOrigin}/replay/${life.id}` : null,
                  traceKept:
                    hasTrace !== null && (life.endedAt ?? life.startedAt).getTime() > traceCutoff,
                };
                controller.enqueue(encoder.encode((first ? "" : ",") + JSON.stringify(row)));
                first = false;
              }
            }
          }
          controller.enqueue(encoder.encode('],"complete":true}'));
          controller.close();
        } catch (error) {
          log("error", "account.export_failed", { error });
          controller.error(error);
        }
      },
    });
  }

  return {
    async exportData(request: Request): Promise<Response> {
      const user = await signedIn(request);
      if (user instanceof Response) return user;
      const data = await snapshot(user.id);
      if (!data) return refuse("unauthorized", "Sign in on the site first.");
      const day = now().toISOString().slice(0, 10);
      return new Response(exportStream(data), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="zerosnake-${data.profile.username ?? "account"}-${day}.json"`,
          "cache-control": "no-store",
        },
      });
    },

    async file(request: Request, versionId: string, kind: string): Promise<Response> {
      const user = await signedIn(request);
      if (user instanceof Response) return user;
      if (kind !== "bundle" && kind !== "source") {
        return refuse("bad_request", "Ask for the bundle or the source.");
      }
      const [row] = await db
        .select({
          n: versions.n,
          slug: bots.slug,
          bundleKey: versions.bundleKey,
          sourceKey: versions.sourceKey,
        })
        .from(versions)
        .innerJoin(bots, eq(bots.id, versions.botId))
        .where(and(eq(versions.id, versionId), eq(bots.ownerId, user.id)))
        .limit(1);
      if (!row) return refuse("not_found", "You have no such version.");
      const bundle = kind === "bundle";
      const object = await (bundle ? env.BUNDLES : env.SOURCES).get(
        bundle ? row.bundleKey : row.sourceKey,
      );
      if (!object) return refuse("not_found", `This version's ${kind} isn't stored any more.`);
      const name = `${row.slug}-v${row.n}${bundle ? ".js" : ".sources.json"}`;
      return new Response(object.body, {
        headers: {
          "content-type": bundle
            ? "text/javascript; charset=utf-8"
            : "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${name}"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    },

    async deleteAccount(request: Request): Promise<Response> {
      if (!sameOrigin(request)) {
        return refuse("forbidden_origin", "This change has to be made from the site itself.");
      }
      const user = await signedIn(request);
      if (user instanceof Response) return user;
      const body = (await request.json().catch(() => null)) as { confirm?: unknown } | null;
      const confirm = typeof body?.confirm === "string" ? body.confirm.trim().toLowerCase() : "";
      const expected = deleteConfirmation(user.username);
      if (confirm !== expected) {
        return refuse(
          "confirmation_mismatch",
          user.username
            ? `Type your username (${user.username}) to confirm.`
            : `Type "${expected}" to confirm.`,
        );
      }

      const at = now().getTime();
      // Read before the batch: the session list is all KV keeps of who the tokens belong to.
      const tokens = await listedSessionTokens(env.AUTH_KV, user.id);
      const statements = DELETE_ACCOUNT_STATEMENTS.map((s) =>
        env.DB.prepare(s).bind(...deleteAccountParams(s, user.id, at)),
      );
      if (user.username) {
        statements.push(
          env.DB.prepare(
            "INSERT OR REPLACE INTO held_usernames (username_hash, until) VALUES (?1, ?2)",
          ).bind(await hashToken(user.username.toLowerCase()), at + USERNAME_HOLD_MS),
        );
      }
      const results = await env.DB.batch<{ id: string; bot_id: string }>(statements);
      log("warn", "account.deleted", { userId: user.id });

      // Revoked in D1 already (`sessions_revoked_at`); this only drops the cached profile copies.
      await Promise.allSettled([
        ...tokens.map((t) => env.AUTH_KV.delete(t)),
        env.AUTH_KV.delete(`active-sessions-${user.id}`),
      ]);
      for (const stopped of results[DELETE_ACCOUNT_STOPPED]?.results ?? []) {
        await notify({
          v: ACTIVE_VERSION_CHANGE_VERSION,
          botId: stopped.bot_id,
          ownerId: user.id,
          reason: "archive_bot",
          versionId: null,
          previousVersionId: stopped.id,
          changedAt: at,
        });
      }
      // The session is revoked already; this only tidies the browser.
      const secure = siteOrigin.startsWith("https:");
      const cookie = `${secure ? "__Secure-" : ""}better-auth.session_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
      return json({ ok: true, purgeAfterMs: ACCOUNT_PURGE_AFTER_MS }, 200, {
        "set-cookie": cookie,
      });
    },
  };
}

export type Account = ReturnType<typeof createAccount>;

// ─── Purge (cron) ────────────────────────────────────────────────────────────────────────────────

export interface PurgeBudget {
  /** Tombstones looked at per run. */
  users: number;
  /** Lives (and their traces) per page. */
  livesPage: number;
  /**
   * Versions per page. Each unshared bundle and source is read before it's deleted (see
   * `deleteUnshared`), so this bounds memory too: at most 25 × (256 KiB + 1 MiB).
   */
  versionsPage: number;
  /** D1 and R2 calls per run, well under the Worker's subrequest limit (1000). */
  subrequests: number;
}

export const PURGE_BUDGET: PurgeBudget = {
  users: 5,
  livesPage: 500,
  versionsPage: 25,
  subrequests: 500,
};

/** Failed runs on one tombstone after which the purge leaves it alone and alerts. */
export const PURGE_MAX_FAILURES = 5;

export interface PurgeResult {
  /** Users erased completely in this run. */
  users: number;
  lives: number;
  versions: number;
  /** Tombstones whose purge threw this run (retried later, after the others). */
  failed: number;
  /** D1 and R2 calls made. */
  subrequests: number;
  /** Work left for the next run. */
  more: boolean;
}

type PurgeEnv = Pick<AccountEnv, "DB" | "BUNDLES" | "SOURCES" | "TRACES">;

/** Most calls one page can make: a versions page is the costly one (`deleteUnshared` × 2). */
const pageCost = (budget: PurgeBudget) => 2 + 2 * (budget.versionsPage * 2 + 3);

/**
 * Deletes those of `keys` that no version of another author names, in one R2 call.
 *
 * A deploy writes its `versions` row before its object, so one with the same content landing
 * between the check and the delete would lose its object. So unshared objects are read first,
 * and after the delete the keys are checked again: any that a version claimed meanwhile is put
 * back. Returns the calls made.
 */
async function deleteUnshared(
  db: D1Database,
  bucket: R2Bucket,
  sql: { unshared: string; claimed: string },
  keys: string[],
  ownerId: string,
): Promise<number> {
  const { results } = await db
    .prepare(sql.unshared)
    .bind(JSON.stringify(keys), ownerId)
    .all<{ key: string }>();
  const unshared = results.map((r) => r.key);
  if (unshared.length === 0) return 1;
  const saved = new Map<string, { bytes: ArrayBuffer; meta: R2HTTPMetadata | undefined }>();
  await Promise.all(
    unshared.map(async (key) => {
      const object = await bucket.get(key);
      if (object) saved.set(key, { bytes: await object.arrayBuffer(), meta: object.httpMetadata });
    }),
  );
  await bucket.delete(unshared);
  const { results: claimed } = await db
    .prepare(sql.claimed)
    .bind(JSON.stringify(unshared), ownerId)
    .all<{ key: string }>();
  let restored = 0;
  for (const { key } of claimed) {
    const copy = saved.get(key);
    if (!copy) continue;
    await bucket.put(key, copy.bytes, { httpMetadata: copy.meta ?? {} });
    restored++;
    log("warn", "account.purge_object_restored", { key });
  }
  return 3 + unshared.length + restored;
}

/**
 * Purges one tombstone as far as `allowance` calls go. Returns whether it's gone, and the
 * calls made.
 */
async function purgeUser(
  env: PurgeEnv,
  id: string,
  budget: PurgeBudget,
  allowance: number,
  result: PurgeResult,
): Promise<{ done: boolean; spent: number }> {
  let spent = 0;
  while (spent + pageCost(budget) <= allowance) {
    const { results: lifeRows } = await env.DB.prepare(PURGE_SQL.selectLives)
      .bind(id, budget.livesPage)
      .all<{ id: string; traceKey: string | null }>();
    spent++;
    if (lifeRows.length > 0) {
      const traces = lifeRows.flatMap((l) => (l.traceKey ? [l.traceKey] : []));
      if (traces.length) {
        await env.TRACES.delete(traces);
        spent++;
      }
      await env.DB.prepare(PURGE_SQL.deleteLives)
        .bind(JSON.stringify(lifeRows.map((l) => l.id)))
        .run();
      spent++;
      result.lives += lifeRows.length;
      continue;
    }
    const { results: versionRows } = await env.DB.prepare(PURGE_SQL.selectVersions)
      .bind(id, budget.versionsPage)
      .all<{ id: string; bundleKey: string; sourceKey: string }>();
    spent++;
    if (versionRows.length > 0) {
      spent += await deleteUnshared(
        env.DB,
        env.BUNDLES,
        { unshared: PURGE_SQL.unsharedBundles, claimed: PURGE_SQL.claimedBundles },
        versionRows.map((v) => v.bundleKey),
        id,
      );
      spent += await deleteUnshared(
        env.DB,
        env.SOURCES,
        { unshared: PURGE_SQL.unsharedSources, claimed: PURGE_SQL.claimedSources },
        versionRows.map((v) => v.sourceKey),
        id,
      );
      await env.DB.prepare(PURGE_SQL.deleteVersions)
        .bind(JSON.stringify(versionRows.map((v) => v.id)))
        .run();
      spent++;
      result.versions += versionRows.length;
      continue;
    }
    await env.DB.prepare(PURGE_SQL.deleteUser).bind(id).run();
    spent++;
    result.users++;
    return { done: true, spent };
  }
  return { done: false, spent };
}

/**
 * Step 2 of account deletion (`src/shared/account.ts`), from the 5-minute cron: for each
 * tombstone older than `ACCOUNT_PURGE_AFTER_MS`, deletes its lives (traces first), then its
 * versions (bundles and sources first, unless shared with another author), then the user row.
 * R2 objects go before the rows that name them, so an interrupted run leaves nothing
 * unreachable; every step is idempotent. A run stops at `budget.subrequests` calls. A
 * tombstone whose purge throws is counted (`users.purge_failures`), retried after the others,
 * and left alone (with an error log to alert on) after `PURGE_MAX_FAILURES`.
 */
export async function purgeDeletedAccounts(
  env: PurgeEnv,
  now: Date,
  budget: PurgeBudget = PURGE_BUDGET,
): Promise<PurgeResult> {
  const result: PurgeResult = {
    users: 0,
    lives: 0,
    versions: 0,
    failed: 0,
    subrequests: 1,
    more: false,
  };
  const due = await env.DB.prepare(PURGE_SQL.dueUsers)
    .bind(now.getTime() - ACCOUNT_PURGE_AFTER_MS, budget.users, PURGE_MAX_FAILURES)
    .all<{ id: string }>();
  for (const { id } of due.results) {
    const allowance = budget.subrequests - result.subrequests;
    if (allowance < pageCost(budget)) {
      result.more = true;
      break;
    }
    try {
      const { done, spent } = await purgeUser(env, id, budget, allowance, result);
      result.subrequests += spent;
      if (!done) {
        result.more = true;
        break;
      }
    } catch (error) {
      result.failed++;
      result.more = true;
      const row = await env.DB.prepare(PURGE_SQL.purgeFailed)
        .bind(id)
        .first<{ failures: number }>()
        .catch(() => null);
      result.subrequests += 2;
      const stuck = (row?.failures ?? 0) >= PURGE_MAX_FAILURES;
      log("error", "account.purge_user_failed", {
        userId: id,
        failures: row?.failures ?? null,
        ...(stuck && { alert: "account_purge_stuck" }),
        error,
      });
    }
  }
  if (!result.more && due.results.length === budget.users) result.more = true;
  if (result.users || result.lives || result.versions || result.failed) {
    log("info", "account.purged", { ...result });
  }
  return result;
}

/**
 * Starts the deletion of accounts that signed in but never chose a username within this long:
 * they can't have bots, and nobody comes back for them (the Privacy Policy says so).
 */
export const UNCLAIMED_ACCOUNT_DAYS = 30;

/** Step 1 of the deletion for up to `limit` accounts unclaimed for `UNCLAIMED_ACCOUNT_DAYS`. */
export async function deleteUnclaimedAccounts(d1: D1Database, now: Date, limit = 20) {
  const before = now.getTime() - UNCLAIMED_ACCOUNT_DAYS * 24 * 60 * 60_000;
  const { results } = await d1
    .prepare(
      `SELECT id FROM users WHERE username IS NULL AND deleted_at IS NULL AND created_at < ?1
       LIMIT ?2`,
    )
    .bind(before, limit)
    .all<{ id: string }>();
  const at = now.getTime();
  for (const { id } of results) {
    await d1.batch(
      DELETE_ACCOUNT_STATEMENTS.map((s) => d1.prepare(s).bind(...deleteAccountParams(s, id, at))),
    );
  }
  if (results.length) log("info", "account.unclaimed_deleted", { users: results.length });
  return results.length;
}

/** How long expired device codes and sign-in state stay, so late polls still read as expired. */
const EXPIRED_GRACE_MS = 60 * 60_000;

/**
 * Retention of sign-in credentials (5-minute cron, as the Privacy Policy states): CLI tokens
 * past their expiry (90 days after last use), and device codes and OAuth state an hour after
 * theirs.
 */
export async function pruneExpiredCredentials(d1: D1Database, now: Date) {
  const db = createDb(d1);
  const grace = new Date(now.getTime() - EXPIRED_GRACE_MS);
  await db.batch([
    db.delete(cliTokens).where(lt(cliTokens.expiresAt, now)),
    db.delete(deviceCodes).where(lt(deviceCodes.expiresAt, grace)),
    db.delete(verifications).where(lt(verifications.expiresAt, grace)),
    db.delete(heldUsernames).where(lt(heldUsernames.until, now)),
  ]);
}
