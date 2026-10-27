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
import { noRateLimit, type RateLimiter, rateLimitedResponse } from "./rate-limit";
import { setRequestOutcome, setRequestUser } from "./request-context";

export const ACCOUNT_EXPORT_FORMAT = "zerosnake-account-export@1";

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
    const { sessionsRevokedAt: _, deletedAt: __, ...profile } = user;
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
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          // `...,"lives":[` + rows + `]}`.
          controller.enqueue(encoder.encode(head.slice(0, -2)));
          let first = true;
          for (const versionId of versionIds) {
            for await (const page of versionLives(versionId)) {
              for (const { hasReplay, replayExpiredAt, hasTrace, seq: _, ...life } of page) {
                const row = {
                  ...life,
                  // Expired replays (`src/server/replays.ts`) have nothing left to link to.
                  replay: hasReplay && !replayExpiredAt ? `${siteOrigin}/replay/${life.id}` : null,
                  traceKept: hasTrace !== null,
                };
                controller.enqueue(encoder.encode((first ? "" : ",") + JSON.stringify(row)));
                first = false;
              }
            }
          }
          controller.enqueue(encoder.encode("]}"));
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
      const expected = (user.username ?? "").toLowerCase();
      if (!expected || confirm !== expected) {
        return refuse(
          "confirmation_mismatch",
          `Type your username${user.username ? ` (${user.username})` : ""} to confirm.`,
        );
      }

      const at = now().getTime();
      // Read before the batch: the session list is all KV keeps of who the tokens belong to.
      const tokens = await listedSessionTokens(env.AUTH_KV, user.id);
      const results = await env.DB.batch<{ id: string; bot_id: string }>(
        DELETE_ACCOUNT_STATEMENTS.map((s) =>
          env.DB.prepare(s).bind(...deleteAccountParams(s, user.id, at)),
        ),
      );
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
      return json({ ok: true, purgeAfterMs: ACCOUNT_PURGE_AFTER_MS });
    },
  };
}

export type Account = ReturnType<typeof createAccount>;

// ─── Purge (cron) ────────────────────────────────────────────────────────────────────────────────

export interface PurgeBudget {
  /** Tombstones looked at per run. */
  users: number;
  /** Rows (and their R2 objects) per page. */
  page: number;
  /** Pages per run, all users together. */
  pages: number;
}

export const PURGE_BUDGET: PurgeBudget = { users: 5, page: 500, pages: 20 };

export interface PurgeResult {
  /** Users erased completely in this run. */
  users: number;
  lives: number;
  versions: number;
  /** Tombstones left for the next run. */
  more: boolean;
}

/**
 * Step 2 of account deletion (`src/shared/account.ts`), from the 5-minute cron: for each
 * tombstone older than `ACCOUNT_PURGE_AFTER_MS`, deletes its lives (traces first), then its
 * versions (bundles and sources first), then the user row. R2 objects go before the rows that
 * name them, so an interrupted run leaves nothing unreachable; every step is idempotent.
 */
export async function purgeDeletedAccounts(
  env: Pick<AccountEnv, "DB" | "BUNDLES" | "SOURCES" | "TRACES">,
  now: Date,
  budget: PurgeBudget = PURGE_BUDGET,
): Promise<PurgeResult> {
  const result: PurgeResult = { users: 0, lives: 0, versions: 0, more: false };
  const due = await env.DB.prepare(PURGE_SQL.dueUsers)
    .bind(now.getTime() - ACCOUNT_PURGE_AFTER_MS, budget.users)
    .all<{ id: string }>();
  let pages = budget.pages;
  for (const { id } of due.results) {
    let done = false;
    while (pages > 0) {
      pages--;
      const { results: lifeRows } = await env.DB.prepare(PURGE_SQL.selectLives)
        .bind(id, budget.page)
        .all<{ id: string; traceKey: string | null }>();
      if (lifeRows.length > 0) {
        const traces = lifeRows.flatMap((l) => (l.traceKey ? [l.traceKey] : []));
        if (traces.length) await env.TRACES.delete(traces);
        await env.DB.prepare(PURGE_SQL.deleteLives)
          .bind(JSON.stringify(lifeRows.map((l) => l.id)))
          .run();
        result.lives += lifeRows.length;
        continue;
      }
      const { results: versionRows } = await env.DB.prepare(PURGE_SQL.selectVersions)
        .bind(id, budget.page)
        .all<{ id: string; bundleKey: string; sourceKey: string }>();
      if (versionRows.length > 0) {
        await env.BUNDLES.delete(versionRows.map((v) => v.bundleKey));
        await env.SOURCES.delete(versionRows.map((v) => v.sourceKey));
        await env.DB.prepare(PURGE_SQL.deleteVersions)
          .bind(JSON.stringify(versionRows.map((v) => v.id)))
          .run();
        result.versions += versionRows.length;
        continue;
      }
      await env.DB.prepare(PURGE_SQL.deleteUser).bind(id).run();
      result.users++;
      done = true;
      break;
    }
    if (!done) {
      result.more = true;
      break;
    }
  }
  if (!result.more && due.results.length === budget.users) result.more = true;
  if (result.users || result.lives || result.versions) log("info", "account.purged", { ...result });
  return result;
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
  ]);
}
