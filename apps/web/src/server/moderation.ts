/**
 * Admin tools behind `/admin`: the kill switch (pause the arena, pause deploys) and bans of
 * users, bots and versions. What each one does to D1, and what the matchmaker must do about it,
 * is the contract in `src/shared/arena.ts` ("Kill switch", "Moderation").
 *
 * Who is an admin: the user ids in `ADMIN_USER_IDS` and the GitHub accounts in
 * `ADMIN_GITHUB_IDS` (comma-separated, wrangler vars). GitHub *ids*, not logins: a login can
 * be renamed and then registered by someone else, an id never changes
 * (`gh api users/<login> --jq .id`). Nothing here relies on the lists being secret.
 *
 * Like bot management (`bot-admin.ts`): only Better Auth web sessions get in (a CLI token is
 * never a session), every change must come from the site's own origin, and every call counts
 * against the caller's `user` rate limit. Non-admins get `not_admin` and learn nothing else.
 *
 * Every action is one D1 batch (a transaction) whose first statement writes the audit row
 * (`moderation_actions`) only if the action applies; the rest is guarded on that row, so an
 * action happens whole or not at all, and two admins banning at once make one ban.
 */
import { log, type MetricsDataset, writeMetric } from "@zerosnake/observability";
import { and, desc, eq, inArray, isNotNull, type SQL, sql } from "drizzle-orm";
import { alias, SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { createDb } from "../db";
import {
  accounts,
  arenaControl,
  bots,
  type ModerationActionKind,
  moderationActions,
  users,
  versions,
} from "../db/schema";
import {
  ACTIVE_VERSION_CHANGE_VERSION,
  type ActiveVersionChange,
  ARENA_CONTROL_VERSION,
  type ArenaControl,
  MODERATION_CHECK_NAME,
} from "../shared/arena";
import type { CheckReport } from "../shared/checks";
import type { WebSession } from "./bot-admin";
import { noRateLimit, type RateLimiter, rateLimitedBody } from "./rate-limit";
import { setRequestOutcome, setRequestUser } from "./request-context";

export interface ModerationEnv {
  DB: D1Database;
  /** Public origin (`BETTER_AUTH_URL`); changes must come from it. */
  BETTER_AUTH_URL: string;
  /** Comma-separated user ids (`users.id`). */
  ADMIN_USER_IDS?: string;
  /** Comma-separated numeric GitHub account ids. */
  ADMIN_GITHUB_IDS?: string;
  METRICS?: MetricsDataset;
}

export interface ModerationOptions {
  getSession: (input: { headers: Headers }) => Promise<WebSession | null>;
  /** Told about each bot whose `ready` version a ban took away, after the commit. */
  notify?: (change: ActiveVersionChange) => Promise<void>;
  /** Told about each change of the kill switch, after the commit. */
  notifyControl?: (control: ArenaControl) => Promise<void>;
  now?: () => Date;
  rateLimiter?: RateLimiter;
}

export type ModerationErrorCode =
  /** No web session (CLI tokens don't count). */
  | "unauthorized"
  /** A change from another origin. */
  | "forbidden_origin"
  /** Signed in, but not in `ADMIN_USER_IDS` / `ADMIN_GITHUB_IDS`. */
  | "not_admin"
  | "rate_limited"
  /** A missing reason, or a target that can't be parsed. */
  | "invalid_request"
  | "user_not_found"
  | "bot_not_found"
  | "version_not_found"
  | "already_banned"
  | "not_banned"
  /** Admins can't ban admins (or themselves); take them off the list first. */
  | "cannot_ban_admin"
  /** The kill switch is already in that position. */
  | "no_change";

export type ModerationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ModerationErrorCode; message: string };

class ModerationError extends Error {
  constructor(
    readonly code: ModerationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function fail(code: ModerationErrorCode, message: string): never {
  throw new ModerationError(code, message);
}

// ─── Page data ───────────────────────────────────────────────────────────────────────────────────

export interface ArenaControlView {
  paused: boolean;
  deploysPaused: boolean;
  /** Why the arena switch last changed. */
  reason: string | null;
  /** Why the deploys switch last changed. */
  deploysReason: string | null;
  updatedAt: string | null;
  /** Username (or id) of the admin who last changed it. */
  updatedBy: string | null;
}

export interface BannedUser {
  id: string;
  username: string | null;
  name: string;
  bannedAt: string;
  reason: string | null;
}

export interface BannedBot {
  id: string;
  name: string;
  slug: string;
  owner: string | null;
  bannedAt: string;
  reason: string | null;
}

export interface ModerationLogEntry {
  id: string;
  action: ModerationActionKind;
  admin: string;
  /** `@user`, `@user/bot` or `@user/bot v3`; the bare id if the target is gone. */
  target: string | null;
  reason: string | null;
  createdAt: string;
}

export interface ModerationPage {
  admin: { id: string; username: string | null };
  control: ArenaControlView;
  bannedUsers: BannedUser[];
  bannedBots: BannedBot[];
  recent: ModerationLogEntry[];
}

/** What a ban did: the bots that stopped playing (their `ready` version was taken away). */
export interface BanResult {
  stoppedVersions: number;
}

/** Entries on the page: the latest actions, and banned users and bots. */
export const MODERATION_LOG_SIZE = 50;
export const BANNED_LIST_SIZE = 100;

const REASON_MAX = 500;

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────────────

const dialect = new SQLiteAsyncDialect();

/** Splits a comma-separated list, dropping blanks. */
export function parseList(value: string | undefined) {
  return new Set(
    (value ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function cleanReason(reason: string) {
  const trimmed = reason.trim();
  if (trimmed.length < 3) fail("invalid_request", "Give a reason (at least 3 characters).");
  if (trimmed.length > REASON_MAX) {
    fail("invalid_request", `Keep the reason under ${REASON_MAX} characters.`);
  }
  return trimmed;
}

/**
 * A target as typed or pasted: an id, `@user`, `@user/bot`, `@user/bot/3`, or a site URL such
 * as `https://…/@user/bot?v=3`. Returns its path segments (without the `@`) and the version.
 */
export function parseTarget(ref: string): { parts: string[]; n: number | null } {
  let path = ref.trim();
  let n: number | null = null;
  if (/^https?:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      path = url.pathname;
      const v = url.searchParams.get("v");
      if (v && /^\d+$/.test(v)) n = Number(v);
    } catch {
      // Not a URL after all; parse it as a path.
    }
  }
  const query = /\?v=(\d+)$/.exec(path);
  if (query) {
    n = Number(query[1]);
    path = path.slice(0, query.index);
  }
  const parts = path
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  if (parts[0]?.startsWith("@")) parts[0] = parts[0].slice(1);
  const last = parts.length === 3 ? /^v?(\d+)$/i.exec(parts[2] ?? "") : null;
  if (last) {
    n = Number(last[1]);
    parts.pop();
  }
  return { parts, n };
}

/** The first line of a banned version's report `text`. */
function moderationHeading(reason: string): string {
  return `Rejected by a moderator: ${reason}`;
}

function moderationReport(message: string): CheckReport {
  return { ok: false, checks: [{ name: MODERATION_CHECK_NAME, ok: false, message }] };
}

// ─── API ─────────────────────────────────────────────────────────────────────────────────────────

export function createModeration(env: ModerationEnv, options: ModerationOptions) {
  const db = createDb(env.DB);
  const now = options.now ?? (() => new Date());
  const notify = options.notify ?? (async () => {});
  const notifyControl = options.notifyControl ?? (async () => {});
  const rateLimiter = options.rateLimiter ?? noRateLimit;
  const siteOrigin = new URL(env.BETTER_AUTH_URL).origin;
  const adminUserIds = parseList(env.ADMIN_USER_IDS);
  const adminGithubIds = new Set(
    [...parseList(env.ADMIN_GITHUB_IDS)].filter((id) => /^\d+$/.test(id)),
  );

  async function isAdmin(userId: string) {
    if (adminUserIds.has(userId)) return true;
    if (adminGithubIds.size === 0) return false;
    const [row] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, userId),
          eq(accounts.providerId, "github"),
          inArray(accounts.accountId, [...adminGithubIds]),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** Same rule as bot management: `Origin`, or `Sec-Fetch-Site` when there's none. */
  function sameOrigin(request: Request) {
    const origin = request.headers.get("origin");
    const ok = origin
      ? origin === siteOrigin
      : request.headers.get("sec-fetch-site") === "same-origin";
    if (!ok) fail("forbidden_origin", "This change has to be made from the site itself.");
  }

  async function run<T>(
    request: Request,
    { mutation }: { mutation: boolean },
    fn: (admin: WebSession["user"]) => Promise<T>,
  ): Promise<ModerationResult<T>> {
    try {
      if (mutation) sameOrigin(request);
      const session = await options.getSession({ headers: request.headers });
      if (!session) fail("unauthorized", "Sign in on the site first.");
      const user = session.user;
      setRequestUser(user.id);
      const verdict = await rateLimiter.check("user", user.id);
      if (!verdict.ok) fail("rate_limited", rateLimitedBody(verdict).message);
      if (!(await isAdmin(user.id))) fail("not_admin", "This page is for admins only.");
      return { ok: true, value: await fn(user) };
    } catch (error) {
      if (error instanceof ModerationError) {
        setRequestOutcome(error.code);
        return { ok: false, error: error.code, message: error.message };
      }
      throw error;
    }
  }

  /** Runs raw statements as one D1 batch; returns each statement's rows (`RETURNING`). */
  async function batch(statements: SQL[]) {
    const results = await env.DB.batch(
      statements.map((statement) => {
        const query = dialect.sqlToQuery(statement);
        return env.DB.prepare(query.sql).bind(...query.params);
      }),
    );
    return results.map((r) => (r.results ?? []) as Record<string, unknown>[]);
  }

  const written = (id: string) => sql`EXISTS (SELECT 1 FROM ${moderationActions} WHERE id = ${id})`;

  function recorded(
    adminId: string,
    action: ModerationActionKind,
    fields: { targetUserId?: string; targetBotId?: string; targetVersionId?: string },
    reason: string,
  ) {
    writeMetric(env.METRICS, "moderation.action", { action });
    log("warn", "moderation.action", { adminId, action, ...fields, reason });
  }

  async function resolveUser(ref: string) {
    const { parts } = parseTarget(ref);
    const key = parts.length === 1 ? parts[0] : undefined;
    if (!key) fail("invalid_request", "Give a username (`@name`) or a user id.");
    const [user] = await db
      .select({ id: users.id, username: users.username, bannedAt: users.bannedAt })
      .from(users)
      .where(sql`${users.username} = ${key.toLowerCase()} OR ${users.id} = ${key}`)
      .limit(1);
    return user ?? fail("user_not_found", `No user "${ref.trim()}".`);
  }

  async function resolveBot(ref: string) {
    const { parts } = parseTarget(ref);
    const select = db
      .select({ bot: bots, owner: { id: users.id, username: users.username } })
      .from(bots)
      .innerJoin(users, eq(users.id, bots.ownerId));
    const [row] =
      parts.length === 2
        ? await select
            .where(
              and(
                eq(users.username, (parts[0] ?? "").toLowerCase()),
                eq(bots.slug, (parts[1] ?? "").toLowerCase()),
              ),
            )
            .limit(1)
        : parts.length === 1
          ? await select.where(eq(bots.id, parts[0] ?? "")).limit(1)
          : fail("invalid_request", "Give a bot as `@user/bot` (or its URL, or its id).");
    return row ?? fail("bot_not_found", `No bot "${ref.trim()}".`);
  }

  async function resolveVersion(ref: string) {
    const { parts, n } = parseTarget(ref);
    const select = db
      .select({ version: versions, bot: bots, owner: { id: users.id } })
      .from(versions)
      .innerJoin(bots, eq(bots.id, versions.botId))
      .innerJoin(users, eq(users.id, bots.ownerId));
    const [row] =
      parts.length === 2 && n !== null
        ? await select
            .where(
              and(
                eq(users.username, (parts[0] ?? "").toLowerCase()),
                eq(bots.slug, (parts[1] ?? "").toLowerCase()),
                eq(versions.n, n),
              ),
            )
            .limit(1)
        : parts.length === 1 && n === null
          ? await select.where(eq(versions.id, parts[0] ?? "")).limit(1)
          : fail(
              "invalid_request",
              "Give a version as `@user/bot/3`, its URL (`…/@user/bot?v=3`) or its id.",
            );
    return row ?? fail("version_not_found", `No version "${ref.trim()}".`);
  }

  async function notifyStopped(
    rows: Record<string, unknown>[],
    ownerId: string,
    changedAt: number,
  ) {
    for (const row of rows) {
      await notify({
        v: ACTIVE_VERSION_CHANGE_VERSION,
        botId: String(row.bot_id),
        ownerId,
        reason: "moderation",
        versionId: null,
        previousVersionId: String(row.id),
        changedAt,
      });
    }
  }

  async function readControl(): Promise<ArenaControlView> {
    const updater = alias(users, "updater");
    const [row] = await db
      .select({ control: arenaControl, updater: { username: updater.username } })
      .from(arenaControl)
      .leftJoin(updater, eq(updater.id, arenaControl.updatedBy))
      .where(eq(arenaControl.id, 1))
      .limit(1);
    if (!row) {
      return {
        paused: false,
        deploysPaused: false,
        reason: null,
        deploysReason: null,
        updatedAt: null,
        updatedBy: null,
      };
    }
    return {
      paused: row.control.paused,
      deploysPaused: row.control.deploysPaused,
      reason: row.control.reason,
      deploysReason: row.control.deploysReason,
      updatedAt: row.control.updatedAt.toISOString(),
      updatedBy: row.updater?.username ?? row.control.updatedBy,
    };
  }

  /**
   * Flips one switch of `arena_control` (made if missing), unless it's already there. Each switch
   * has its own reason column, so resuming one never rewrites why the other is off.
   */
  async function setControl(
    adminId: string,
    column: "paused" | "deploys_paused",
    on: boolean,
    reason: string,
  ) {
    const action: ModerationActionKind =
      column === "paused"
        ? on
          ? "pause_arena"
          : "resume_arena"
        : on
          ? "pause_deploys"
          : "resume_deploys";
    const id = crypto.randomUUID();
    const at = now().getTime();
    const value = on ? 1 : 0;
    const reasonColumn = sql.raw(column === "paused" ? "reason" : "deploys_reason");
    const current = sql`coalesce((SELECT ${sql.raw(column)} FROM ${arenaControl} WHERE id = 1), 0)`;
    const [inserted] = await batch([
      sql`INSERT INTO ${moderationActions} (id, admin_id, action, reason, created_at)
          SELECT ${id}, ${adminId}, ${action}, ${reason}, ${at} WHERE ${current} != ${value}
          RETURNING id`,
      sql`INSERT INTO ${arenaControl}
            (id, ${sql.raw(column)}, ${reasonColumn}, updated_by, updated_at)
          SELECT 1, ${value}, ${reason}, ${adminId}, ${at} WHERE ${written(id)}
          ON CONFLICT (id) DO UPDATE SET ${sql.raw(column)} = excluded.${sql.raw(column)},
            ${reasonColumn} = excluded.${reasonColumn}, updated_by = excluded.updated_by,
            updated_at = excluded.updated_at`,
    ]);
    if (!inserted?.length) {
      fail(
        "no_change",
        column === "paused"
          ? `The arena is already ${on ? "paused" : "running"}.`
          : `Deploys are already ${on ? "paused" : "open"}.`,
      );
    }
    recorded(adminId, action, {}, reason);
    const view = await readControl();
    await notifyControl({
      v: ARENA_CONTROL_VERSION,
      paused: view.paused,
      deploysPaused: view.deploysPaused,
      reason: view.reason,
      deploysReason: view.deploysReason,
      updatedAt: at,
    });
    return view;
  }

  /** The `UPDATE`s a ban makes to a set of bots' versions (`botIds`: a subquery or an id). */
  function stopVersions(id: string, botIds: SQL, at: number, rejectMessage: string) {
    const report = JSON.stringify(moderationReport(rejectMessage));
    return [
      sql`UPDATE ${versions} SET status = 'archived', updated_at = ${at}
          WHERE status = 'ready' AND bot_id IN (${botIds}) AND ${written(id)}
          RETURNING id, bot_id`,
      // The checks consumer skips versions that aren't `validating` any more.
      sql`UPDATE ${versions} SET status = 'rejected', report = ${report}, updated_at = ${at}
          WHERE status = 'validating' AND bot_id IN (${botIds}) AND ${written(id)}`,
    ];
  }

  return {
    /** Whether the user is an admin (for the site's navigation; not an authorization check). */
    isAdmin,

    overview: (request: Request) =>
      run(request, { mutation: false }, async (admin): Promise<ModerationPage> => {
        const owner = alias(users, "owner");
        const actor = alias(users, "actor");
        const targetUser = alias(users, "target_user");
        const targetBot = alias(bots, "target_bot");
        const targetBotOwner = alias(users, "target_bot_owner");
        const targetVersion = alias(versions, "target_version");
        const versionBot = alias(bots, "version_bot");
        const versionOwner = alias(users, "version_owner");

        const [control, bannedUsers, bannedBots, recent] = await Promise.all([
          readControl(),
          db
            .select({
              id: users.id,
              username: users.username,
              name: users.name,
              bannedAt: users.bannedAt,
              reason: users.banReason,
            })
            .from(users)
            .where(isNotNull(users.bannedAt))
            .orderBy(desc(users.bannedAt))
            .limit(BANNED_LIST_SIZE),
          db
            .select({
              id: bots.id,
              name: bots.name,
              slug: bots.slug,
              owner: owner.username,
              bannedAt: bots.bannedAt,
              reason: bots.banReason,
            })
            .from(bots)
            .innerJoin(owner, eq(owner.id, bots.ownerId))
            .where(isNotNull(bots.bannedAt))
            .orderBy(desc(bots.bannedAt))
            .limit(BANNED_LIST_SIZE),
          db
            .select({
              action: moderationActions,
              actor: actor.username,
              targetUser: targetUser.username,
              targetBot: { slug: targetBot.slug, owner: targetBotOwner.username },
              targetVersion: {
                n: targetVersion.n,
                slug: versionBot.slug,
                owner: versionOwner.username,
              },
            })
            .from(moderationActions)
            .leftJoin(actor, eq(actor.id, moderationActions.adminId))
            .leftJoin(targetUser, eq(targetUser.id, moderationActions.targetUserId))
            .leftJoin(targetBot, eq(targetBot.id, moderationActions.targetBotId))
            .leftJoin(targetBotOwner, eq(targetBotOwner.id, targetBot.ownerId))
            .leftJoin(targetVersion, eq(targetVersion.id, moderationActions.targetVersionId))
            .leftJoin(versionBot, eq(versionBot.id, targetVersion.botId))
            .leftJoin(versionOwner, eq(versionOwner.id, versionBot.ownerId))
            .orderBy(desc(moderationActions.createdAt))
            .limit(MODERATION_LOG_SIZE),
        ]);

        return {
          admin: { id: admin.id, username: admin.username ?? null },
          control,
          bannedUsers: bannedUsers.map((u) => ({
            ...u,
            bannedAt: (u.bannedAt as Date).toISOString(),
          })),
          bannedBots: bannedBots.map((b) => ({
            ...b,
            bannedAt: (b.bannedAt as Date).toISOString(),
          })),
          recent: recent.map(
            ({ action: a, actor: by, targetUser: tu, targetBot: tb, targetVersion: tv }) => {
              const target = tv?.slug
                ? `@${tv.owner ?? "?"}/${tv.slug} v${tv.n}`
                : tb?.slug
                  ? `@${tb.owner ?? "?"}/${tb.slug}`
                  : tu
                    ? `@${tu}`
                    : (a.targetVersionId ?? a.targetBotId ?? a.targetUserId);
              return {
                id: a.id,
                action: a.action,
                admin: by ?? a.adminId,
                target,
                reason: a.reason,
                createdAt: a.createdAt.toISOString(),
              };
            },
          ),
        };
      }),

    setArenaPaused: (request: Request, input: { paused: boolean; reason: string }) =>
      run(request, { mutation: true }, (admin) =>
        setControl(admin.id, "paused", input.paused, cleanReason(input.reason)),
      ),

    setDeploysPaused: (request: Request, input: { paused: boolean; reason: string }) =>
      run(request, { mutation: true }, (admin) =>
        setControl(admin.id, "deploys_paused", input.paused, cleanReason(input.reason)),
      ),

    banUser: (request: Request, input: { user: string; reason: string }) =>
      run(request, { mutation: true }, async (admin): Promise<BanResult> => {
        const reason = cleanReason(input.reason);
        const target = await resolveUser(input.user);
        if (await isAdmin(target.id)) {
          fail("cannot_ban_admin", "Admins can't be banned; take them off the admin list first.");
        }
        const id = crypto.randomUUID();
        const at = now().getTime();
        const [inserted, , stopped] = await batch([
          sql`INSERT INTO ${moderationActions}
                (id, admin_id, action, target_user_id, reason, created_at)
              SELECT ${id}, ${admin.id}, 'ban_user', id, ${reason}, ${at}
              FROM ${users} WHERE id = ${target.id} AND banned_at IS NULL
              RETURNING id`,
          sql`UPDATE ${users} SET banned_at = ${at}, ban_reason = ${reason}
              WHERE id = ${target.id} AND ${written(id)}`,
          ...stopVersions(
            id,
            sql`SELECT id FROM ${bots} WHERE owner_id = ${target.id}`,
            at,
            "The author's account was suspended before the checks ended.",
          ),
        ]);
        if (!inserted?.length)
          fail("already_banned", `@${target.username ?? target.id} is already banned.`);
        recorded(admin.id, "ban_user", { targetUserId: target.id }, reason);
        await notifyStopped(stopped ?? [], target.id, at);
        return { stoppedVersions: stopped?.length ?? 0 };
      }),

    unbanUser: (request: Request, input: { user: string; reason: string }) =>
      run(request, { mutation: true }, async (admin) => {
        const reason = cleanReason(input.reason);
        const target = await resolveUser(input.user);
        const id = crypto.randomUUID();
        const at = now().getTime();
        const [inserted] = await batch([
          sql`INSERT INTO ${moderationActions}
                (id, admin_id, action, target_user_id, reason, created_at)
              SELECT ${id}, ${admin.id}, 'unban_user', id, ${reason}, ${at}
              FROM ${users} WHERE id = ${target.id} AND banned_at IS NOT NULL
              RETURNING id`,
          sql`UPDATE ${users} SET banned_at = NULL, ban_reason = NULL
              WHERE id = ${target.id} AND ${written(id)}`,
        ]);
        if (!inserted?.length) fail("not_banned", `@${target.username ?? target.id} isn't banned.`);
        recorded(admin.id, "unban_user", { targetUserId: target.id }, reason);
        return { userId: target.id };
      }),

    banBot: (request: Request, input: { bot: string; reason: string }) =>
      run(request, { mutation: true }, async (admin): Promise<BanResult> => {
        const reason = cleanReason(input.reason);
        const { bot, owner } = await resolveBot(input.bot);
        const id = crypto.randomUUID();
        const at = now().getTime();
        const [inserted, , stopped] = await batch([
          sql`INSERT INTO ${moderationActions}
                (id, admin_id, action, target_user_id, target_bot_id, reason, created_at)
              SELECT ${id}, ${admin.id}, 'ban_bot', owner_id, id, ${reason}, ${at}
              FROM ${bots} WHERE id = ${bot.id} AND banned_at IS NULL
              RETURNING id`,
          sql`UPDATE ${bots} SET banned_at = ${at}, ban_reason = ${reason}
              WHERE id = ${bot.id} AND ${written(id)}`,
          ...stopVersions(id, sql`${bot.id}`, at, "The bot was banned before the checks ended."),
        ]);
        if (!inserted?.length) fail("already_banned", `"${bot.name}" is already banned.`);
        recorded(admin.id, "ban_bot", { targetUserId: owner.id, targetBotId: bot.id }, reason);
        await notifyStopped(stopped ?? [], owner.id, at);
        return { stoppedVersions: stopped?.length ?? 0 };
      }),

    unbanBot: (request: Request, input: { bot: string; reason: string }) =>
      run(request, { mutation: true }, async (admin) => {
        const reason = cleanReason(input.reason);
        const { bot, owner } = await resolveBot(input.bot);
        const id = crypto.randomUUID();
        const at = now().getTime();
        const [inserted] = await batch([
          sql`INSERT INTO ${moderationActions}
                (id, admin_id, action, target_user_id, target_bot_id, reason, created_at)
              SELECT ${id}, ${admin.id}, 'unban_bot', owner_id, id, ${reason}, ${at}
              FROM ${bots} WHERE id = ${bot.id} AND banned_at IS NOT NULL
              RETURNING id`,
          sql`UPDATE ${bots} SET banned_at = NULL, ban_reason = NULL
              WHERE id = ${bot.id} AND ${written(id)}`,
        ]);
        if (!inserted?.length) fail("not_banned", `"${bot.name}" isn't banned.`);
        recorded(admin.id, "unban_bot", { targetUserId: owner.id, targetBotId: bot.id }, reason);
        return { botId: bot.id };
      }),

    /** Rejects one version for good, whatever its status; the rest of the bot is untouched. */
    banVersion: (request: Request, input: { version: string; reason: string }) =>
      run(request, { mutation: true }, async (admin): Promise<BanResult> => {
        const reason = cleanReason(input.reason);
        const { version, bot, owner } = await resolveVersion(input.version);
        const id = crypto.randomUUID();
        const at = now().getTime();
        const check = JSON.stringify({ name: MODERATION_CHECK_NAME, ok: false, message: reason });
        const heading = `${moderationHeading(reason)}\n\n`;
        const [inserted, banned] = await batch([
          sql`INSERT INTO ${moderationActions}
                (id, admin_id, action, target_user_id, target_bot_id, target_version_id, reason,
                 created_at)
              SELECT ${id}, ${admin.id}, 'ban_version', ${owner.id}, bot_id, id, ${reason}, ${at}
              FROM ${versions} WHERE id = ${version.id} AND status != 'rejected'
              RETURNING id`,
          // Earlier checks stay in the report, the moderation check is appended. The consumer's
          // `text` (what the CLI prints, "Checks passed…") gets the verdict on top, so nobody
          // reads it as a pass.
          sql`UPDATE ${versions}
              SET status = 'rejected', updated_at = ${at},
                report = json_replace(
                  json_set(
                    json_insert(coalesce(report, '{"ok":false,"checks":[]}'), '$.checks[#]', json(${check})),
                    '$.ok', json('false')),
                  '$.text', ${heading} || json_extract(report, '$.text'))
              WHERE id = ${version.id} AND ${written(id)}
              RETURNING id, bot_id`,
        ]);
        if (!inserted?.length) {
          fail("already_banned", `v${version.n} of "${bot.name}" is already rejected.`);
        }
        recorded(
          admin.id,
          "ban_version",
          { targetUserId: owner.id, targetBotId: bot.id, targetVersionId: version.id },
          reason,
        );
        // `version` was read before the batch; if it became `ready` in between, the matchmaker
        // still finds out from `change_seq`.
        if (version.status === "ready") await notifyStopped(banned ?? [], owner.id, at);
        return { stoppedVersions: version.status === "ready" ? 1 : 0 };
      }),
  };
}

export type Moderation = ReturnType<typeof createModeration>;
