/**
 * The CLI API (SPEC §6): `GET /api/me`, `POST /api/bots`, `POST /api/bots/:bot/versions` and
 * `GET /api/bots/:bot/versions/:n`. Shapes and error codes are in `src/shared/deploy.ts`.
 *
 * Only CLI tokens (`authenticateCli`) get in; browser sessions don't, and CLI tokens in turn
 * can't use Better Auth (see cli-auth.ts). No CORS headers, so other sites' scripts can't call it.
 *
 * A deploy: limits are checked on the request alone. A single `INSERT … SELECT` makes the
 * `validating` version: it picks the next `n` and enforces the daily quota in the same statement,
 * so concurrent deploys can't share an `n` or overrun the quota. Then the bundle and the source
 * archive go to R2 under content-addressed keys (`<sha256>.js` in `BUNDLES`, `<sha256>.json` in
 * `SOURCES`), a `CheckJob` goes on `CHECKS_QUEUE` for apps/arena, and the row gets `enqueued_at`.
 * If uploading or queueing fails, the version is `abandon`ed (`rejected`, not counted).
 *
 * With an `Idempotency-Key`, a retry returns the version once it's queued, gets 409
 * `deploy_in_progress` while the first request is still going, and takes over a deploy stuck
 * unqueued for over a minute.
 */
import { and, count, desc, eq, gte, isNull, or, type SQLWrapper, sql } from "drizzle-orm";
import * as z from "zod";
import { createDb, type Db } from "../db";
import { bots, versions } from "../db/schema";
import {
  CHECK_JOB_VERSION,
  type CheckJob,
  type CheckReport,
  SOURCE_ARCHIVE_FORMAT,
  type SourceArchive,
  type SourceFile,
} from "../shared/checks";
import {
  type ApiErrorBody,
  type BotInfo,
  DEPLOY_LIMITS,
  type DeployLimits,
  type DeployMeta,
  type DeployResponse,
  type MeResponse,
  type QuotaInfo,
  type VersionInfo,
} from "../shared/deploy";
import { authenticateCli, type CliIdentity } from "./cli-auth";

export interface CliApiEnv {
  DB: D1Database;
  BUNDLES: R2Bucket;
  SOURCES: R2Bucket;
  CHECKS_QUEUE: { send(body: CheckJob, options?: QueueSendOptions): Promise<unknown> };
  /** Overrides `DEPLOY_LIMITS.deploysPerDay`. */
  DEPLOYS_PER_DAY?: string;
  /** Overrides `DEPLOY_LIMITS.botsPerAuthor`. */
  BOTS_PER_AUTHOR?: string;
}

export interface CliApiOptions {
  /** Clock for the daily quota; tests move it. */
  now?: () => Date;
  /** Override any limit (tests); otherwise `DEPLOY_LIMITS` plus the env overrides. */
  limits?: Partial<DeployLimits>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/;
const BOT_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** An unqueued `validating` deploy older than this is taken over by a retry with its key. */
const STALE_DEPLOY_MS = 60_000;

/** Versions that never got queued (`abandon`ed) don't use up the daily quota. */
const countsAgainstQuota = (v: SQLWrapper) =>
  sql`NOT (${v}.enqueued_at IS NULL AND ${v}.status = 'rejected')`;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message);
  }
}

function fail(status: number, body: ApiErrorBody): never {
  throw new HttpError(status, body);
}

function unavailable(what: string): never {
  return fail(503, {
    error: "unavailable",
    message: `${what}, so nothing was deployed. Try again in a minute.`,
  });
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

const utf8 = new TextEncoder();

async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const positiveInt = (value: string | undefined) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

function utcDayStart(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// ─── Request bodies ──────────────────────────────────────────────────────────────────────────────

/** Reads a JSON body without ever holding more than `maxBytes` of it. */
async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    fail(415, { error: "unsupported_media_type", message: "Send the body as application/json." });
  }
  const tooLarge = (actual?: number): never =>
    fail(413, {
      error: "body_too_large",
      message: `Request body is over ${formatBytes(maxBytes)}.`,
      limit: maxBytes,
      ...(actual === undefined ? {} : { actual }),
    });
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) tooLarge(declared);
  if (!request.body) fail(400, { error: "invalid_request", message: "Request body is empty." });

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail(400, { error: "invalid_request", message: "Request body is not valid JSON." });
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  return fail(400, { error: "invalid_request", message: `${where}${issue?.message ?? "invalid"}` });
}

const deployBody = z.object({
  bundle: z.string().min(1, "the bundle is empty"),
  sources: z
    .array(z.object({ path: z.string(), content: z.string() }))
    .min(1, "at least one source file is required"),
  meta: z
    .object({
      cliVersion: z.string().max(32).optional(),
      sdkVersion: z.string().max(32).optional(),
      message: z.string().max(200).optional(),
    })
    .optional(),
});

const createBotBody = z.object({
  name: z.string(),
  slug: z.string().optional(),
});

/** Why `path` isn't an acceptable source path, or `null` if it is. */
export function sourcePathProblem(path: string, maxLength: number = DEPLOY_LIMITS.maxPathLength) {
  if (path.length === 0) return "is empty";
  if (path.length > maxLength) return `is longer than ${maxLength} characters`;
  if (path.includes("\\")) return "must use / as the separator";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "must be relative";
  for (const segment of path.split("/")) {
    if (segment === "") return "has an empty segment (// or a trailing /)";
    if (segment === "." || segment === "..") return "must not contain . or .. segments";
    if (!PATH_SEGMENT.test(segment)) {
      return "may only contain letters, digits and . _ - @ + (no spaces)";
    }
  }
  return null;
}

/** Before schema validation, so a huge `sources` array isn't validated entry by entry. */
function checkFileCount(raw: unknown, limits: DeployLimits) {
  const sources = (raw as { sources?: unknown } | null)?.sources;
  if (Array.isArray(sources) && sources.length > limits.maxSourceFiles) {
    fail(422, {
      error: "too_many_files",
      message: `${sources.length} source files; the limit is ${limits.maxSourceFiles}.`,
      limit: limits.maxSourceFiles,
      actual: sources.length,
    });
  }
}

/** Applies the per-request limits; returns the bytes to store, source files sorted by path. */
function checkDeploy(body: z.infer<typeof deployBody>, limits: DeployLimits) {
  const seen = new Set<string>();
  let sourceBytes = 0;
  for (const { path, content } of body.sources) {
    const problem = sourcePathProblem(path, limits.maxPathLength);
    if (problem) {
      fail(422, { error: "invalid_path", message: `Source path "${path}" ${problem}.`, path });
    }
    // Case-insensitively, so the archive unpacks the same on macOS and Windows.
    const folded = path.toLowerCase();
    if (seen.has(folded)) {
      fail(422, { error: "duplicate_path", message: `Source path "${path}" appears twice.`, path });
    }
    seen.add(folded);
    sourceBytes += utf8.encode(content).byteLength;
  }
  if (sourceBytes > limits.maxSourceBytes) {
    fail(422, {
      error: "sources_too_large",
      message: `Sources are ${formatBytes(sourceBytes)}; the limit is ${formatBytes(limits.maxSourceBytes)}.`,
      limit: limits.maxSourceBytes,
      actual: sourceBytes,
    });
  }
  const bundle = utf8.encode(body.bundle);
  if (bundle.byteLength > limits.maxBundleBytes) {
    fail(422, {
      error: "bundle_too_large",
      message: `The bundle is ${formatBytes(bundle.byteLength)}; the limit is ${formatBytes(limits.maxBundleBytes)}.`,
      limit: limits.maxBundleBytes,
      actual: bundle.byteLength,
    });
  }
  const files: SourceFile[] = body.sources
    .map(({ path, content }) => ({ path, content }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const archive: SourceArchive = { format: SOURCE_ARCHIVE_FORMAT, files };
  return { bundle, archive: utf8.encode(JSON.stringify(archive)) };
}

function formatBytes(n: number) {
  if (n >= 1024 * 1024) return `${+(n / (1024 * 1024)).toFixed(2)} MB`;
  if (n >= 1024) return `${+(n / 1024).toFixed(1)} KB`;
  return `${n} bytes`;
}

/** Bot names are free text; the slug is the URL segment (`/@user/slug`) and the CLI handle. */
function checkBotName(body: z.infer<typeof createBotBody>) {
  const name = body.name.trim();
  if (name.length === 0 || name.length > 40 || /\p{Cc}/u.test(name)) {
    fail(422, {
      error: "invalid_bot_name",
      message: "A bot name is 1–40 characters, without control characters.",
    });
  }
  const slug =
    body.slug === undefined
      ? name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 32)
          .replace(/-+$/, "")
      : body.slug.toLowerCase();
  if (!BOT_SLUG.test(slug)) {
    fail(422, {
      error: "invalid_bot_name",
      message:
        body.slug === undefined
          ? `Can't make a slug from "${name}"; pass one: 1–32 of a-z, 0-9 and -, not starting or ending with -.`
          : "A slug is 1–32 of a-z, 0-9 and -, not starting or ending with -.",
    });
  }
  return { name, slug };
}

function toMeta(meta: z.infer<typeof deployBody>["meta"]): DeployMeta | null {
  if (!meta) return null;
  const out: DeployMeta = {};
  if (meta.cliVersion !== undefined) out.cliVersion = meta.cliVersion;
  if (meta.sdkVersion !== undefined) out.sdkVersion = meta.sdkVersion;
  if (meta.message !== undefined) out.message = meta.message;
  return Object.keys(out).length ? out : null;
}

// ─── API ─────────────────────────────────────────────────────────────────────────────────────────

type BotRow = typeof bots.$inferSelect;
type VersionRow = typeof versions.$inferSelect;

const botInfo = (bot: BotRow): BotInfo => ({
  id: bot.id,
  slug: bot.slug,
  name: bot.name,
  createdAt: bot.createdAt.toISOString(),
});

const versionInfo = (bot: BotRow, v: VersionRow): VersionInfo => ({
  id: v.id,
  bot: { id: bot.id, slug: bot.slug },
  n: v.n,
  status: v.status,
  report: v.report ?? null,
  meta: v.meta ?? null,
  createdAt: v.createdAt.toISOString(),
  updatedAt: v.updatedAt.toISOString(),
});

export function createCliApi(env: CliApiEnv, options: CliApiOptions = {}) {
  const db: Db = createDb(env.DB);
  const now = options.now ?? (() => new Date());
  const limits: DeployLimits = {
    ...DEPLOY_LIMITS,
    deploysPerDay: positiveInt(env.DEPLOYS_PER_DAY) ?? DEPLOY_LIMITS.deploysPerDay,
    botsPerAuthor: positiveInt(env.BOTS_PER_AUTHOR) ?? DEPLOY_LIMITS.botsPerAuthor,
    ...options.limits,
  };

  /** Runs `fn` for an authenticated CLI caller; turns `HttpError`s into JSON responses. */
  async function withCli(request: Request, fn: (identity: CliIdentity) => Promise<Response>) {
    try {
      const identity = await authenticateCli(db, request.headers);
      if (!identity) {
        const browser = request.headers.has("cookie") && !request.headers.has("authorization");
        fail(401, {
          error: "unauthorized",
          message: browser
            ? "This API takes a CLI token, not a browser session. Run `zerosnake login`."
            : "Missing, expired or revoked CLI token. Run `zerosnake login`.",
        });
      }
      return await fn(identity);
    } catch (error) {
      if (!(error instanceof HttpError)) {
        console.error("CLI API error", request.method, new URL(request.url).pathname, error);
        return json(
          {
            error: "internal_error",
            message: "Something went wrong on our side. Try again; if it keeps failing, report it.",
          } satisfies ApiErrorBody,
          500,
        );
      }
      const headers: Record<string, string> =
        error.status === 401 ? { "www-authenticate": 'Bearer realm="zerosnake"' } : {};
      return json(error.body, error.status, headers);
    }
  }

  /** `:bot` is one of the caller's bots, by slug or id. */
  async function ownBot(userId: string, param: string): Promise<BotRow> {
    const [bot] = await db
      .select()
      .from(bots)
      .where(
        and(eq(bots.ownerId, userId), or(eq(bots.slug, param.toLowerCase()), eq(bots.id, param))),
      )
      .limit(1);
    if (bot) return bot;
    const [other] = await db.select({ id: bots.id }).from(bots).where(eq(bots.id, param)).limit(1);
    if (other) fail(403, { error: "not_bot_owner", message: "That bot belongs to someone else." });
    return fail(404, {
      error: "bot_not_found",
      message: `You have no bot "${param}". Create it first (POST /api/bots).`,
    });
  }

  async function quota(ownerId: string): Promise<QuotaInfo> {
    const dayStart = utcDayStart(now());
    const [row] = await db
      .select({ n: count() })
      .from(versions)
      .innerJoin(bots, eq(bots.id, versions.botId))
      .where(
        and(
          eq(bots.ownerId, ownerId),
          gte(versions.createdAt, dayStart),
          countsAgainstQuota(versions),
        ),
      )
      .limit(1);
    return {
      deploysToday: row?.n ?? 0,
      deploysPerDay: limits.deploysPerDay,
      resetsAt: new Date(dayStart.getTime() + DAY_MS).toISOString(),
    };
  }

  const quotaExceeded = (q: QuotaInfo): never =>
    fail(429, {
      error: "quota_exceeded",
      message: `You've used all ${q.deploysPerDay} deploys for today; more at ${q.resetsAt} (00:00 UTC).`,
      limit: q.deploysPerDay,
      quota: q,
    });

  async function versionByKey(botId: string, idempotencyKey: string) {
    const [row] = await db
      .select()
      .from(versions)
      .where(and(eq(versions.botId, botId), eq(versions.idempotencyKey, idempotencyKey)))
      .limit(1);
    return row;
  }

  const inProgress = (): never =>
    fail(409, {
      error: "deploy_in_progress",
      message: "A deploy with this Idempotency-Key is still being processed. Try again shortly.",
    });

  /**
   * Makes the `validating` version, not yet queued. Next `n` and the daily quota in one
   * statement: D1 runs statements one at a time, so concurrent deploys can't take the same `n`
   * or squeeze past the quota. `undefined` if the quota is used up or the key is taken.
   */
  async function insertVersion(
    bot: BotRow,
    ownerId: string,
    keys: { bundleKey: string; sourceKey: string },
    rawMeta: z.infer<typeof deployBody>["meta"],
    idempotencyKey: string | null,
  ) {
    const id = crypto.randomUUID();
    const createdAt = now().getTime();
    const meta = toMeta(rawMeta);
    const inserted = await db.all<{ n: number }>(sql`
      INSERT INTO ${versions}
        (id, bot_id, n, status, bundle_key, source_key, meta, idempotency_key, created_at, updated_at)
      SELECT ${id}, ${bot.id},
        coalesce((SELECT max(n) FROM ${versions} WHERE bot_id = ${bot.id}), 0) + 1,
        'validating', ${keys.bundleKey}, ${keys.sourceKey}, ${meta && JSON.stringify(meta)},
        ${idempotencyKey}, ${createdAt}, ${createdAt}
      WHERE (
        SELECT count(*) FROM ${versions} AS v JOIN ${bots} AS b ON b.id = v.bot_id
        WHERE b.owner_id = ${ownerId} AND v.created_at >= ${utcDayStart(now()).getTime()}
          AND ${countsAgainstQuota(sql`v`)}
      ) < ${limits.deploysPerDay}
      ON CONFLICT DO NOTHING
      RETURNING n`);
    const n = inserted[0]?.n;
    return n === undefined ? undefined : { id, n };
  }

  /**
   * Ends a deploy that never got queued (upload or enqueue failed, or it was interrupted):
   * `rejected` with a report saying why, out of the daily quota, Idempotency-Key released so a
   * retry starts over. Only touches a row that is still `validating` and unqueued; `false` if
   * the row moved on meanwhile.
   */
  async function abandon(id: string, reason: string) {
    const report: CheckReport = {
      ok: false,
      checks: [{ name: "deploy", ok: false, message: reason }],
    };
    const ended = await db
      .update(versions)
      .set({ status: "rejected", report, idempotencyKey: null })
      .where(
        and(eq(versions.id, id), eq(versions.status, "validating"), isNull(versions.enqueuedAt)),
      )
      .returning({ id: versions.id });
    return ended.length > 0;
  }

  /** Like `abandon`, for error paths. If D1 fails here too, a retry takes the row over later. */
  async function abandonQuietly(id: string, reason: string) {
    try {
      await abandon(id, reason);
    } catch (error) {
      console.error("abandoning version failed", id, error);
    }
  }

  /** Uploads to R2, enqueues the `CheckJob`, marks the version queued. */
  async function finishDeploy(
    bot: BotRow,
    { id, n }: { id: string; n: number },
    upload: {
      bundle: Uint8Array<ArrayBuffer>;
      archive: Uint8Array<ArrayBuffer>;
      bundleHash: string;
      archiveHash: string;
    },
    idempotencyKey: string | null,
  ) {
    const [row] = await db.select().from(versions).where(eq(versions.id, id)).limit(1);
    if (!row) throw new Error(`version ${id} vanished after insert`);
    try {
      // Content-addressed, so a retry or another author's identical upload rewrites the same bytes.
      await Promise.all([
        env.BUNDLES.put(row.bundleKey, upload.bundle, {
          httpMetadata: { contentType: "text/javascript; charset=utf-8" },
          sha256: upload.bundleHash,
        }),
        env.SOURCES.put(row.sourceKey, upload.archive, {
          httpMetadata: { contentType: "application/json; charset=utf-8" },
          sha256: upload.archiveHash,
        }),
      ]);
    } catch (error) {
      console.error("R2 upload failed", id, error);
      await abandonQuietly(id, "The upload couldn't be stored.");
      unavailable("Couldn't store the upload");
    }

    const job: CheckJob = {
      v: CHECK_JOB_VERSION,
      versionId: id,
      botId: bot.id,
      ownerId: bot.ownerId,
      n,
      bundleKey: row.bundleKey,
      sourceKey: row.sourceKey,
      enqueuedAt: Date.now(),
    };
    try {
      await env.CHECKS_QUEUE.send(job, { contentType: "json" });
    } catch (error) {
      // `send` may have delivered anyway; the consumer skips versions that aren't `validating`.
      console.error("CHECKS_QUEUE.send failed", id, error);
      await abandonQuietly(id, "The checks couldn't be queued.");
      unavailable("Couldn't queue the checks");
    }

    // Unless a retry took this deploy over meanwhile (that releases the key). The checks may
    // already have run, so don't require `validating`.
    const marked = await db
      .update(versions)
      .set({ enqueuedAt: now() })
      .where(and(eq(versions.id, id), sql`${versions.idempotencyKey} IS ${idempotencyKey}`))
      .returning();
    const version = marked[0];
    if (!version) unavailable("This deploy was interrupted and a retry replaced it");
    return json(
      {
        version: versionInfo(bot, version),
        quota: await quota(bot.ownerId),
      } satisfies DeployResponse,
      201,
      { location: `/api/bots/${bot.slug}/versions/${n}` },
    );
  }

  return {
    limits,

    me: (request: Request) =>
      withCli(request, async ({ user }) => {
        const rows = await db
          .select()
          .from(bots)
          .where(eq(bots.ownerId, user.id))
          .orderBy(bots.createdAt);
        const botList: MeResponse["bots"] = await Promise.all(
          rows.map(async (bot) => {
            const [latest] = await db
              .select({ n: versions.n, status: versions.status, createdAt: versions.createdAt })
              .from(versions)
              .where(eq(versions.botId, bot.id))
              .orderBy(desc(versions.n))
              .limit(1);
            const [active] = await db
              .select({ n: versions.n })
              .from(versions)
              .where(and(eq(versions.botId, bot.id), eq(versions.status, "ready")))
              .limit(1);
            return {
              ...botInfo(bot),
              activeVersion: active?.n ?? null,
              latestVersion: latest
                ? { n: latest.n, status: latest.status, createdAt: latest.createdAt.toISOString() }
                : null,
            };
          }),
        );
        return json({
          user,
          bots: botList,
          quota: await quota(user.id),
          limits,
        } satisfies MeResponse);
      }),

    createBot: (request: Request) =>
      withCli(request, async ({ user }) => {
        const { name, slug } = checkBotName(
          parse(createBotBody, await readJson(request, 16 * 1024)),
        );
        // One statement, so concurrent creations can't overrun the limit.
        const id = crypto.randomUUID();
        const created = await db.all<{ id: string }>(sql`
          INSERT INTO ${bots} (id, owner_id, name, slug, created_at)
          SELECT ${id}, ${user.id}, ${name}, ${slug}, ${now().getTime()}
          WHERE (SELECT count(*) FROM ${bots} WHERE owner_id = ${user.id}) < ${limits.botsPerAuthor}
          ON CONFLICT DO NOTHING
          RETURNING id`);
        const [bot] = await db
          .select()
          .from(bots)
          .where(and(eq(bots.ownerId, user.id), eq(bots.slug, slug)))
          .limit(1);
        if (created.length === 0 || !bot) {
          if (bot) {
            fail(409, {
              error: "bot_exists",
              message: `You already have a bot "${slug}".`,
              bot: botInfo(bot),
            });
          }
          fail(403, {
            error: "bot_limit_reached",
            message: `You already have ${limits.botsPerAuthor} bots, the most an author can have.`,
            limit: limits.botsPerAuthor,
          });
        }
        return json(botInfo(bot) satisfies BotInfo, 201);
      }),

    deploy: (request: Request, botParam: string) =>
      withCli(request, async ({ user }) => {
        const bot = await ownBot(user.id, botParam);
        const idempotencyKey = request.headers.get("idempotency-key");
        if (idempotencyKey !== null && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
          fail(400, {
            error: "invalid_request",
            message: "Idempotency-Key must be 8–128 of A-Z, a-z, 0-9, _ and -.",
          });
        }
        const raw = await readJson(request, limits.maxBodyBytes);
        checkFileCount(raw, limits);
        const body = parse(deployBody, raw);
        const { bundle, archive } = checkDeploy(body, limits);
        const [bundleHash, archiveHash] = await Promise.all([sha256(bundle), sha256(archive)]);
        const keys = { bundleKey: `${bundleHash}.js`, sourceKey: `${archiveHash}.json` };
        const upload = { bundle, archive, bundleHash, archiveHash };

        /**
         * What an earlier request with this Idempotency-Key left: replay it if it got queued
         * (or checked), 409 while it's in flight, or take it over once it's stale. `null` means
         * the key is free.
         */
        async function settle(): Promise<Response | null> {
          if (!idempotencyKey) return null;
          for (let attempt = 0; attempt < 3; attempt++) {
            const existing = await versionByKey(bot.id, idempotencyKey);
            if (!existing) return null;
            if (existing.bundleKey !== keys.bundleKey || existing.sourceKey !== keys.sourceKey) {
              fail(409, {
                error: "idempotency_conflict",
                message: "This Idempotency-Key was already used for a different upload.",
              });
            }
            if (existing.enqueuedAt || existing.status !== "validating") {
              return json({
                version: versionInfo(bot, existing),
                quota: await quota(user.id),
              } satisfies DeployResponse);
            }
            if (now().getTime() - existing.createdAt.getTime() < STALE_DEPLOY_MS) break;
            // The request that made it died before queueing it: end it and start over.
            if (await abandon(existing.id, "This deploy was interrupted and retried.")) return null;
          }
          return inProgress();
        }

        for (let attempt = 0; attempt < 3; attempt++) {
          const settled = await settle();
          if (settled) return settled;
          const version = await insertVersion(bot, user.id, keys, body.meta, idempotencyKey);
          if (version) return finishDeploy(bot, version, upload, idempotencyKey);
          // Nothing inserted: the quota is used up, or a concurrent retry took the key.
          if (!idempotencyKey || !(await versionByKey(bot.id, idempotencyKey))) {
            quotaExceeded(await quota(user.id));
          }
        }
        return inProgress();
      }),

    getVersion: (request: Request, botParam: string, nParam: string) =>
      withCli(request, async ({ user }) => {
        const bot = await ownBot(user.id, botParam);
        const n = /^[1-9]\d{0,8}$/.test(nParam) ? Number(nParam) : null;
        const [version] =
          n === null
            ? []
            : await db
                .select()
                .from(versions)
                .where(and(eq(versions.botId, bot.id), eq(versions.n, n)))
                .limit(1);
        if (!version) {
          fail(404, {
            error: "version_not_found",
            message: `Bot "${bot.slug}" has no version ${nParam}.`,
          });
        }
        return json(versionInfo(bot, version) satisfies VersionInfo);
      }),
  };
}

export type CliApi = ReturnType<typeof createCliApi>;
