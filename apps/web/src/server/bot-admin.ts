/**
 * Bot management for signed-in authors on the site (`/bots`): create, rename, archive and
 * restore bots, choose the active version, see quotas and rejected versions' reports.
 *
 * Only Better Auth web sessions get in (`getSession` reads the session cookie; there is no
 * `bearer()` plugin, so a CLI token in `Authorization` is never a session), and every call that
 * changes something must come from the site's own origin.
 *
 * Rules:
 * - At most `botsPerAuthor` active bots; archived ones don't count, so archiving frees a slot.
 *   Creating and restoring check the limit in the same statement as the write.
 * - A slug never changes (renames change the display name only) and stays taken while archived,
 *   so `/@user/slug` links and the CLI's handle keep working.
 * - Archiving a bot archives its active version and rejects versions still in checks, in one
 *   transaction, so an archived bot never has a `ready` version. Restoring brings it back with
 *   no active version; the owner picks one (or deploys).
 * - Exactly one `ready` version per bot (partial unique index `versions_bot_ready_idx`). A
 *   rollback archives the current one and readies the chosen one in one D1 batch (a transaction,
 *   run without other statements in between), the old one first, so the index never sees two.
 * - Only `archived` versions can be made active again: a version is archived only once it was
 *   `ready`, so it passed the checks. `rejected` ones (checks, arena bans) can't.
 * - A rollback starts the version's rating over (its `ratings` row is deleted, `activated_at`
 *   moves) and uses one of the day's deploys (`src/server/quota.ts`). Keeping a frozen rating
 *   would let an author deploy many versions and switch to whichever got the luckiest run
 *   (the "redeploy lottery"); restarting it for free would let them roll back until a run of 30
 *   lives comes out lucky. Archiving the active version costs nothing.
 * - Bans (`src/server/moderation.ts`): a banned user can still look, but changes nothing. A
 *   banned bot can't be restored or given an active version until an admin lifts the ban.
 * - Every call counts against the user's `user` rate limit (`src/server/rate-limit.ts`).
 *
 * After each change of the active version the matchmaker is told (`src/shared/arena.ts`).
 */
import { and, desc, eq, inArray, lt, type SQL, sql } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { createDb, type Db } from "../db";
import { activations, bots, ratings, versions } from "../db/schema";
import {
  ACTIVE_VERSION_CHANGE_VERSION,
  type ActiveVersionChange,
  type ActiveVersionChangeReason,
  ARENA_LIMITS,
  MATCHMAKER_NAME,
  type MatchmakerSiteRpc,
} from "../shared/arena";
import { type CheckReport, checkReportLines } from "../shared/checks";
import { DEPLOY_LIMITS, type QuotaInfo, type VersionStatus } from "../shared/deploy";
import { botNameProblem, parseBotName } from "./bot-names";
import { deployQuota, quotaUsedSql, utcDayStart } from "./quota";
import { noRateLimit, type RateLimiter, rateLimitedBody } from "./rate-limit";
import { setRequestOutcome, setRequestUser } from "./request-context";

export interface BotAdminEnv {
  DB: D1Database;
  /** Public origin (`BETTER_AUTH_URL`); state-changing calls must come from it. */
  BETTER_AUTH_URL: string;
  DEPLOYS_PER_DAY?: string;
  BOTS_PER_AUTHOR?: string;
}

export interface WebSession {
  user: {
    id: string;
    username?: string | null | undefined;
    bannedAt?: Date | null | undefined;
    banReason?: string | null | undefined;
  };
}

export interface BotAdminOptions {
  /** Better Auth's `api.getSession`: the web session behind a request's cookies, if any. */
  getSession: (input: { headers: Headers }) => Promise<WebSession | null>;
  /** Told about every change of a bot's active version, after it's committed. */
  notify?: (change: ActiveVersionChange) => Promise<void>;
  now?: () => Date;
  limits?: Partial<BotAdminLimits>;
  /** Per-user rate limits; none if left out. */
  rateLimiter?: RateLimiter;
}

export interface BotAdminLimits {
  botsPerAuthor: number;
  deploysPerDay: number;
  livesPerBotPerDay: number;
}

/** Versions listed per bot, newest first, and per page of older ones (`olderVersions`). */
export const MANAGED_VERSIONS = 20;
/** The most older versions one `olderVersions` call returns. */
export const MAX_VERSIONS_PAGE = 500;
/** Rejected versions listed with their reports. */
export const RECENT_REJECTED = 10;

// ─── Results ─────────────────────────────────────────────────────────────────────────────────────

export type AdminErrorCode =
  /** No web session (CLI tokens don't count). */
  | "unauthorized"
  /** A state-changing call from another origin. */
  | "forbidden_origin"
  | "invalid_bot_name"
  /** No such bot or version among the caller's (others' look the same: no IDOR oracle). */
  | "bot_not_found"
  | "version_not_found"
  | "bot_exists"
  | "bot_limit_reached"
  | "bot_archived"
  | "bot_not_archived"
  | "already_active"
  | "not_active"
  /** Only `archived` versions (once `ready`) can be made active again. */
  | "version_not_activatable"
  | "quota_exceeded"
  /** An admin suspended the account: it can look, not change. */
  | "user_banned"
  /** An admin banned the bot. */
  | "bot_banned"
  /** Too many calls in a short time; try again in a minute. */
  | "rate_limited";

export type AdminResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AdminErrorCode; message: string };

class AdminError extends Error {
  constructor(
    readonly code: AdminErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function fail(code: AdminErrorCode, message: string): never {
  throw new AdminError(code, message);
}

// ─── Page data ───────────────────────────────────────────────────────────────────────────────────

export interface ManagedVersion {
  id: string;
  n: number;
  status: VersionStatus;
  createdAt: string;
  activatedAt: string | null;
  lives: number;
  rating: { mean: number; ci: number; nLives: number } | null;
  /** The deploy's message (`zerosnake deploy -m`), if any. */
  message: string | null;
  /** Failed checks as sentences (`checkReportLines`); empty unless rejected. */
  problems: string[];
  canActivate: boolean;
}

export interface ManagedBot {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  archivedAt: string | null;
  /** Set while an admin has banned the bot. */
  banned: Ban | null;
  /** The `ready` version, however old (it may not be among `versions`). */
  activeVersion: ManagedVersion | null;
  /** Lives started since 00:00 UTC, all versions. */
  livesToday: number;
  versionCount: number;
  /** The latest `MANAGED_VERSIONS`; `olderVersions` pages through the rest. */
  versions: ManagedVersion[];
}

export interface VersionsPage {
  /** Newest first, all older than the `before` asked for. */
  versions: ManagedVersion[];
  /** Whether there are older ones still. */
  hasMore: boolean;
}

export interface RejectedVersion {
  botId: string;
  botName: string;
  botSlug: string;
  versionId: string;
  n: number;
  createdAt: string;
  problems: string[];
}

export interface Ban {
  at: string;
  reason: string | null;
}

export interface ManagePage {
  username: string | null;
  /** Set while an admin has suspended the account. */
  banned: Ban | null;
  /** Active bots first (oldest first), then archived ones (latest archived first). */
  bots: ManagedBot[];
  activeBots: number;
  quota: QuotaInfo;
  limits: BotAdminLimits;
  /** `MANAGED_VERSIONS`: versions per bot on the page, and per `olderVersions` page. */
  versionsPerPage: number;
  rejected: RejectedVersion[];
}

export interface ActivationResult {
  change: ActiveVersionChange;
  quota: QuotaInfo;
}

// ─── Matchmaker ──────────────────────────────────────────────────────────────────────────────────

const NOTIFY_TIMEOUT_MS = 2_000;

/** Renders `sql` templates for raw D1 batches (Drizzle's `batch` takes no raw SQL). */
const dialect = new SQLiteAsyncDialect();

/**
 * Calls a `MatchmakerSiteRpc` method on the global `MatchmakerDO`, best effort: errors and
 * timeouts are logged, never thrown, since the matchmaker reconciles from D1 anyway.
 */
export async function callMatchmaker(
  namespace: DurableObjectNamespace | undefined,
  call: (stub: MatchmakerSiteRpc) => Promise<void>,
  detail: unknown,
) {
  if (!namespace) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stub = namespace.get(
      namespace.idFromName(MATCHMAKER_NAME),
    ) as unknown as MatchmakerSiteRpc;
    await Promise.race([
      call(stub),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), NOTIFY_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    console.warn("matchmaker not notified; it will pick the change up from D1", detail, error);
  } finally {
    clearTimeout(timer);
  }
}

/** `activeVersionChanged`, through `callMatchmaker`. */
export function matchmakerNotifier(namespace: DurableObjectNamespace | undefined) {
  return (change: ActiveVersionChange) =>
    callMatchmaker(namespace, (stub) => stub.activeVersionChanged(change), change);
}

// ─── API ─────────────────────────────────────────────────────────────────────────────────────────

const positiveInt = (value: string | undefined) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

type BotRow = typeof bots.$inferSelect;
type VersionRow = typeof versions.$inferSelect;
type RatingRow = typeof ratings.$inferSelect;

function managedVersion(
  bot: Pick<BotRow, "archivedAt" | "bannedAt">,
  v: VersionRow,
  rating: RatingRow | null,
): ManagedVersion {
  return {
    id: v.id,
    n: v.n,
    status: v.status,
    createdAt: v.createdAt.toISOString(),
    activatedAt: v.activatedAt?.toISOString() ?? null,
    lives: v.livesCount,
    rating: rating && { mean: rating.mean, ci: rating.ci, nLives: rating.nLives },
    message: v.meta?.message ?? null,
    problems: v.status === "rejected" ? checkReportLines(v.report) : [],
    canActivate: v.status === "archived" && bot.archivedAt === null && bot.bannedAt === null,
  };
}

/**
 * Creates a bot if the owner has fewer than `limit` active bots. One statement, so concurrent
 * creations can't overrun the limit. Also used by the CLI API.
 */
export async function insertBot(
  db: Db,
  {
    ownerId,
    name,
    slug,
    limit,
    now,
  }: {
    ownerId: string;
    name: string;
    slug: string;
    limit: number;
    now: Date;
  },
): Promise<{ created: BotRow } | { existing: BotRow } | { limitReached: true }> {
  const id = crypto.randomUUID();
  const created = await db.all<{ id: string }>(sql`
    INSERT INTO ${bots} (id, owner_id, name, slug, created_at)
    SELECT ${id}, ${ownerId}, ${name}, ${slug}, ${now.getTime()}
    WHERE (
      SELECT count(*) FROM ${bots} WHERE owner_id = ${ownerId} AND archived_at IS NULL
    ) < ${limit}
    ON CONFLICT DO NOTHING
    RETURNING id`);
  const [bot] = await db
    .select()
    .from(bots)
    .where(and(eq(bots.ownerId, ownerId), eq(bots.slug, slug)))
    .limit(1);
  if (created.length > 0 && bot) return { created: bot };
  return bot ? { existing: bot } : { limitReached: true };
}

export function createBotAdmin(env: BotAdminEnv, options: BotAdminOptions) {
  const db = createDb(env.DB);
  const now = options.now ?? (() => new Date());
  const notify = options.notify ?? (async () => {});
  const rateLimiter = options.rateLimiter ?? noRateLimit;
  const siteOrigin = new URL(env.BETTER_AUTH_URL).origin;
  const limits: BotAdminLimits = {
    botsPerAuthor: positiveInt(env.BOTS_PER_AUTHOR) ?? DEPLOY_LIMITS.botsPerAuthor,
    deploysPerDay: positiveInt(env.DEPLOYS_PER_DAY) ?? DEPLOY_LIMITS.deploysPerDay,
    livesPerBotPerDay: ARENA_LIMITS.livesPerBotPerDay,
    ...options.limits,
  };

  async function webUser(request: Request) {
    const session = await options.getSession({ headers: request.headers });
    if (!session) fail("unauthorized", "Sign in on the site to manage your bots.");
    return session.user;
  }

  /**
   * Cookies ride along on cross-site requests in some cases, so changes must also prove they
   * come from our pages: `Origin` (sent by browsers on POST) or `Sec-Fetch-Site`.
   */
  function sameOrigin(request: Request) {
    const origin = request.headers.get("origin");
    const ok = origin
      ? origin === siteOrigin
      : request.headers.get("sec-fetch-site") === "same-origin";
    if (!ok) fail("forbidden_origin", "This change has to be made from the site itself.");
  }

  /** Runs `fn` for the signed-in user; `AdminError`s become `{ ok: false }` results. */
  async function run<T>(
    request: Request,
    { mutation }: { mutation: boolean },
    fn: (userId: string, user: WebSession["user"]) => Promise<T>,
  ): Promise<AdminResult<T>> {
    try {
      if (mutation) sameOrigin(request);
      const user = await webUser(request);
      setRequestUser(user.id);
      const verdict = await rateLimiter.check("user", user.id);
      if (!verdict.ok) fail("rate_limited", rateLimitedBody(verdict).message);
      if (mutation && user.bannedAt) {
        fail(
          "user_banned",
          `Your account is suspended${user.banReason ? `: ${user.banReason}` : ""}. Your bots can't be changed.`,
        );
      }
      return { ok: true, value: await fn(user.id, user) };
    } catch (error) {
      if (error instanceof AdminError) {
        setRequestOutcome(error.code);
        return { ok: false, error: error.code, message: error.message };
      }
      throw error;
    }
  }

  async function ownBot(userId: string, botId: string): Promise<BotRow> {
    const [bot] = await db
      .select()
      .from(bots)
      .where(and(eq(bots.id, botId), eq(bots.ownerId, userId)))
      .limit(1);
    return bot ?? fail("bot_not_found", "You have no such bot.");
  }

  async function ownVersion(userId: string, versionId: string) {
    const [row] = await db
      .select({ version: versions, bot: bots })
      .from(versions)
      .innerJoin(bots, eq(bots.id, versions.botId))
      .where(and(eq(versions.id, versionId), eq(bots.ownerId, userId)))
      .limit(1);
    return row ?? fail("version_not_found", "You have no such version.");
  }

  const quota = (userId: string) => deployQuota(db, userId, now(), limits.deploysPerDay);

  /**
   * Runs an activation change as one D1 batch (a transaction). `insert` writes the `activations`
   * row `id` only if every precondition holds; each of `then` must be guarded by `written(id)`,
   * so either all of it happens or none. Returns the row, or `null` if a precondition failed.
   */
  async function changeActive(id: string, insert: SQL, then: SQL[]) {
    await env.DB.batch(
      [insert, ...then].map((statement) => {
        const query = dialect.sqlToQuery(statement);
        return env.DB.prepare(query.sql).bind(...query.params);
      }),
    );
    // Written once and never changed, so reading it afterwards is as good as inside the batch.
    const [row] = await db.select().from(activations).where(eq(activations.id, id)).limit(1);
    return row ?? null;
  }

  function toChange(
    row: typeof activations.$inferSelect,
    reason: ActiveVersionChangeReason,
  ): ActiveVersionChange {
    return {
      v: ACTIVE_VERSION_CHANGE_VERSION,
      botId: row.botId,
      ownerId: row.ownerId,
      reason,
      versionId: row.versionId,
      previousVersionId: row.previousVersionId,
      changedAt: row.createdAt.getTime(),
    };
  }

  const written = (id: string) => sql`EXISTS (SELECT 1 FROM ${activations} WHERE id = ${id})`;

  return {
    limits,

    overview: (request: Request) =>
      run(request, { mutation: false }, async (userId, user): Promise<ManagePage> => {
        const dayStart = utcDayStart(now()).getTime();
        const botRows = await db
          .select({
            bot: bots,
            livesToday: sql<number>`(
              SELECT count(*) FROM lives AS l JOIN ${versions} AS v ON v.id = l.version_id
              WHERE v.bot_id = ${bots}.id AND l.started_at >= ${dayStart}
                AND (l.ended_at IS NULL OR l.ended_at >= ${dayStart})
            )`,
            versionCount: sql<number>`(
              SELECT count(*) FROM ${versions} AS v WHERE v.bot_id = ${bots}.id
            )`,
          })
          .from(bots)
          .where(eq(bots.ownerId, userId))
          .orderBy(sql`${bots.archivedAt} IS NOT NULL`, desc(bots.archivedAt), bots.createdAt);

        const botIds = botRows.map((r) => r.bot.id);
        const versionRows = botIds.length
          ? await db
              .select({ version: versions, rating: ratings })
              .from(versions)
              .leftJoin(ratings, eq(ratings.versionId, versions.id))
              .where(
                and(
                  inArray(versions.botId, botIds),
                  sql`${versions}.n > (
                    SELECT coalesce(max(v.n), 0) FROM ${versions} AS v WHERE v.bot_id = ${versions}.bot_id
                  ) - ${MANAGED_VERSIONS}`,
                ),
              )
              .orderBy(desc(versions.n))
          : [];
        // Separately, since the active version may be older than the latest `MANAGED_VERSIONS`.
        const activeRows = botIds.length
          ? await db
              .select({ version: versions, rating: ratings })
              .from(versions)
              .leftJoin(ratings, eq(ratings.versionId, versions.id))
              .where(and(inArray(versions.botId, botIds), eq(versions.status, "ready")))
          : [];

        const managedBots = botRows.map(({ bot, livesToday, versionCount }): ManagedBot => {
          const active = activeRows.find((r) => r.version.botId === bot.id);
          return {
            id: bot.id,
            name: bot.name,
            slug: bot.slug,
            createdAt: bot.createdAt.toISOString(),
            archivedAt: bot.archivedAt?.toISOString() ?? null,
            banned: bot.bannedAt ? { at: bot.bannedAt.toISOString(), reason: bot.banReason } : null,
            activeVersion: active ? managedVersion(bot, active.version, active.rating) : null,
            livesToday,
            versionCount,
            versions: versionRows
              .filter((r) => r.version.botId === bot.id)
              .map((r) => managedVersion(bot, r.version, r.rating)),
          };
        });

        const rejectedRows = botIds.length
          ? await db
              .select({
                bot: { id: bots.id, name: bots.name, slug: bots.slug },
                version: {
                  id: versions.id,
                  n: versions.n,
                  createdAt: versions.createdAt,
                  report: versions.report,
                },
              })
              .from(versions)
              .innerJoin(bots, eq(bots.id, versions.botId))
              .where(and(eq(bots.ownerId, userId), eq(versions.status, "rejected")))
              .orderBy(desc(versions.createdAt))
              .limit(RECENT_REJECTED)
          : [];

        return {
          username: user.username ?? null,
          banned: user.bannedAt
            ? { at: user.bannedAt.toISOString(), reason: user.banReason ?? null }
            : null,
          bots: managedBots,
          activeBots: botRows.filter((r) => r.bot.archivedAt === null).length,
          quota: await quota(userId),
          limits,
          versionsPerPage: MANAGED_VERSIONS,
          rejected: rejectedRows.map(({ bot, version }) => ({
            botId: bot.id,
            botName: bot.name,
            botSlug: bot.slug,
            versionId: version.id,
            n: version.n,
            createdAt: version.createdAt.toISOString(),
            problems: checkReportLines(version.report),
          })),
        };
      }),

    /** A bot's versions older than `before` (a version number), newest first. */
    olderVersions: (
      request: Request,
      input: { botId: string; before: number; limit?: number | undefined },
    ) =>
      run(request, { mutation: false }, async (userId): Promise<VersionsPage> => {
        const bot = await ownBot(userId, input.botId);
        const limit = Math.min(Math.max(1, input.limit ?? MANAGED_VERSIONS), MAX_VERSIONS_PAGE);
        const rows = await db
          .select({ version: versions, rating: ratings })
          .from(versions)
          .leftJoin(ratings, eq(ratings.versionId, versions.id))
          .where(and(eq(versions.botId, bot.id), lt(versions.n, input.before)))
          .orderBy(desc(versions.n))
          .limit(limit + 1);
        return {
          versions: rows.slice(0, limit).map((r) => managedVersion(bot, r.version, r.rating)),
          hasMore: rows.length > limit,
        };
      }),

    createBot: (request: Request, input: { name: string; slug?: string | undefined }) =>
      run(request, { mutation: true }, async (userId) => {
        const parsed = parseBotName(input);
        if (!parsed.ok) fail("invalid_bot_name", parsed.message);
        const result = await insertBot(db, {
          ownerId: userId,
          name: parsed.name,
          slug: parsed.slug,
          limit: limits.botsPerAuthor,
          now: now(),
        });
        if ("created" in result) return { id: result.created.id, slug: result.created.slug };
        if ("existing" in result) {
          fail(
            "bot_exists",
            result.existing.archivedAt
              ? `You already have a bot "${parsed.slug}"; it's archived. Restore it instead.`
              : `You already have a bot "${parsed.slug}".`,
          );
        }
        return fail(
          "bot_limit_reached",
          `You already have ${limits.botsPerAuthor} active bots. Archive one to free a slot.`,
        );
      }),

    renameBot: (request: Request, input: { botId: string; name: string }) =>
      run(request, { mutation: true }, async (userId) => {
        const name = input.name.trim();
        const problem = botNameProblem(name);
        if (problem) fail("invalid_bot_name", problem);
        const [bot] = await db
          .update(bots)
          .set({ name })
          .where(and(eq(bots.id, input.botId), eq(bots.ownerId, userId)))
          .returning({ id: bots.id, name: bots.name, slug: bots.slug });
        return bot ?? fail("bot_not_found", "You have no such bot.");
      }),

    archiveBot: (request: Request, input: { botId: string }) =>
      run(request, { mutation: true }, async (userId) => {
        const id = crypto.randomUUID();
        const at = now().getTime();
        const report: CheckReport = {
          ok: false,
          checks: [
            { name: "deploy", ok: false, message: "The bot was archived before the checks ended." },
          ],
        };
        const row = await changeActive(
          id,
          sql`INSERT INTO ${activations}
                (id, owner_id, bot_id, kind, version_id, previous_version_id, created_at)
              SELECT ${id}, ${userId}, b.id, 'archive_bot', NULL,
                (SELECT v.id FROM ${versions} AS v WHERE v.bot_id = b.id AND v.status = 'ready'),
                ${at}
              FROM ${bots} AS b
              WHERE b.id = ${input.botId} AND b.owner_id = ${userId} AND b.archived_at IS NULL`,
          [
            sql`UPDATE ${bots} SET archived_at = ${at}
                WHERE id = ${input.botId} AND ${written(id)}`,
            sql`UPDATE ${versions} SET status = 'archived', updated_at = ${at}
                WHERE bot_id = ${input.botId} AND status = 'ready' AND ${written(id)}`,
            // The checks consumer skips versions that aren't `validating` any more.
            sql`UPDATE ${versions}
                SET status = 'rejected', report = ${JSON.stringify(report)}, updated_at = ${at}
                WHERE bot_id = ${input.botId} AND status = 'validating' AND ${written(id)}`,
          ],
        );
        if (!row) {
          const bot = await ownBot(userId, input.botId);
          if (bot.archivedAt) fail("bot_archived", `"${bot.name}" is already archived.`);
          throw new Error(`archiving bot ${input.botId} failed for no known reason`);
        }
        const change = toChange(row, "archive_bot");
        if (change.previousVersionId) await notify(change);
        return { change };
      }),

    restoreBot: (request: Request, input: { botId: string }) =>
      run(request, { mutation: true }, async (userId) => {
        const restored = await db.all<{ id: string }>(sql`
          UPDATE ${bots} SET archived_at = NULL
          WHERE id = ${input.botId} AND owner_id = ${userId} AND archived_at IS NOT NULL
            AND banned_at IS NULL
            AND (
              SELECT count(*) FROM ${bots} WHERE owner_id = ${userId} AND archived_at IS NULL
            ) < ${limits.botsPerAuthor}
          RETURNING id`);
        if (restored.length > 0) return { id: input.botId };
        const bot = await ownBot(userId, input.botId);
        if (!bot.archivedAt) fail("bot_not_archived", `"${bot.name}" isn't archived.`);
        if (bot.bannedAt) fail("bot_banned", `"${bot.name}" is banned, so it can't be restored.`);
        return fail(
          "bot_limit_reached",
          `You already have ${limits.botsPerAuthor} active bots. Archive one to restore "${bot.name}".`,
        );
      }),

    /** Rollback: makes an earlier (`archived`) version the bot's active one. */
    activateVersion: (request: Request, input: { versionId: string }) =>
      run(request, { mutation: true }, async (userId): Promise<ActivationResult> => {
        const id = crypto.randomUUID();
        const at = now();
        const t = at.getTime();
        const row = await changeActive(
          id,
          sql`INSERT INTO ${activations}
                (id, owner_id, bot_id, kind, version_id, previous_version_id, created_at)
              SELECT ${id}, ${userId}, v.bot_id, 'activate', v.id,
                (SELECT r.id FROM ${versions} AS r WHERE r.bot_id = v.bot_id AND r.status = 'ready'),
                ${t}
              FROM ${versions} AS v JOIN ${bots} AS b ON b.id = v.bot_id
              WHERE v.id = ${input.versionId} AND b.owner_id = ${userId}
                AND b.archived_at IS NULL AND b.banned_at IS NULL AND v.status = 'archived'
                AND ${quotaUsedSql(userId, utcDayStart(at))} < ${limits.deploysPerDay}`,
          [
            // The current one first, so the unique index never sees two `ready` versions.
            sql`UPDATE ${versions} SET status = 'archived', updated_at = ${t}
                WHERE status = 'ready'
                  AND bot_id = (SELECT bot_id FROM ${activations} WHERE id = ${id})`,
            sql`UPDATE ${versions} SET status = 'ready', activated_at = ${t}, updated_at = ${t}
                WHERE id = ${input.versionId} AND ${written(id)}`,
            // A rollback starts the rating over (see the top of this file).
            sql`DELETE FROM ${ratings} WHERE version_id = ${input.versionId} AND ${written(id)}`,
          ],
        );
        if (!row) {
          const { version, bot } = await ownVersion(userId, input.versionId);
          if (bot.bannedAt) fail("bot_banned", `"${bot.name}" is banned, so it can't play.`);
          if (bot.archivedAt) {
            fail("bot_archived", `"${bot.name}" is archived. Restore it first.`);
          }
          if (version.status === "ready") {
            fail("already_active", `v${version.n} is already the active version.`);
          }
          if (version.status !== "archived") {
            fail(
              "version_not_activatable",
              version.status === "rejected"
                ? `v${version.n} was rejected, so it can't play.`
                : `v${version.n} is still being checked; it becomes active by itself if it passes.`,
            );
          }
          const q = await quota(userId);
          if (q.deploysToday >= q.deploysPerDay) {
            fail(
              "quota_exceeded",
              `You've used all ${q.deploysPerDay} deploys and rollbacks for today; more at 00:00 UTC.`,
            );
          }
          throw new Error(`activating version ${input.versionId} failed for no known reason`);
        }
        const change = toChange(row, "activate");
        await notify(change);
        return { change, quota: await quota(userId) };
      }),

    /** Archives the bot's active version, so the bot stops playing until another is active. */
    archiveVersion: (request: Request, input: { versionId: string }) =>
      run(request, { mutation: true }, async (userId) => {
        const id = crypto.randomUUID();
        const at = now().getTime();
        const row = await changeActive(
          id,
          sql`INSERT INTO ${activations}
                (id, owner_id, bot_id, kind, version_id, previous_version_id, created_at)
              SELECT ${id}, ${userId}, v.bot_id, 'deactivate', NULL, v.id, ${at}
              FROM ${versions} AS v JOIN ${bots} AS b ON b.id = v.bot_id
              WHERE v.id = ${input.versionId} AND b.owner_id = ${userId} AND v.status = 'ready'`,
          [
            sql`UPDATE ${versions} SET status = 'archived', updated_at = ${at}
                WHERE id = ${input.versionId} AND ${written(id)}`,
          ],
        );
        if (!row) {
          const { version } = await ownVersion(userId, input.versionId);
          fail("not_active", `v${version.n} isn't the active version.`);
        }
        const change = toChange(row, "deactivate");
        await notify(change);
        return { change };
      }),
  };
}

export type BotAdmin = ReturnType<typeof createBotAdmin>;
