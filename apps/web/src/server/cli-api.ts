/**
 * The CLI API (SPEC §6): `GET /api/me`, `POST /api/bots`, `POST /api/bots/:bot/versions` and
 * `GET /api/bots/:bot/versions/:n`. Shapes and error codes are in `src/shared/deploy.ts`.
 *
 * Only CLI tokens (`authenticateCli`) get in; browser sessions don't, and CLI tokens in turn
 * can't use Better Auth (see cli-auth.ts). No CORS headers, so other sites' scripts can't call it.
 *
 * A deploy: limits are checked on the request alone, the bundle and the source archive go to R2
 * under content-addressed keys (`<sha256>.js` in `BUNDLES`, `<sha256>.json` in `SOURCES`), then a
 * single `INSERT … SELECT` makes the `validating` version: it picks the next `n` and enforces the
 * daily quota in the same statement, so concurrent deploys can't share an `n` or overrun the
 * quota. Last, a `CheckJob` goes on `CHECKS_QUEUE` for apps/arena.
 */
import { and, count, desc, eq, gte, or, sql } from "drizzle-orm";
import * as z from "zod";
import { createDb, type Db } from "../db";
import { bots, versions } from "../db/schema";
import {
  CHECK_JOB_VERSION,
  type CheckJob,
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

/** Applies every per-request limit; returns the archive to store, files sorted by path. */
function checkDeploy(body: z.infer<typeof deployBody>, limits: DeployLimits) {
  if (body.sources.length > limits.maxSourceFiles) {
    fail(422, {
      error: "too_many_files",
      message: `${body.sources.length} source files; the limit is ${limits.maxSourceFiles}.`,
      limit: limits.maxSourceFiles,
      actual: body.sources.length,
    });
  }
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
      if (!(error instanceof HttpError)) throw error;
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
      .where(and(eq(bots.ownerId, ownerId), gte(versions.createdAt, dayStart)))
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

  /** The answer to a retry that found its version already made. */
  async function replay(bot: BotRow, existing: VersionRow, bundleKey: string, sourceKey: string) {
    if (existing.bundleKey !== bundleKey || existing.sourceKey !== sourceKey) {
      fail(409, {
        error: "idempotency_conflict",
        message: "This Idempotency-Key was already used for a different upload.",
      });
    }
    return json({
      version: versionInfo(bot, existing),
      quota: await quota(bot.ownerId),
    } satisfies DeployResponse);
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
        const body = parse(deployBody, await readJson(request, limits.maxBodyBytes));
        const { bundle, archive } = checkDeploy(body, limits);
        const [bundleHash, archiveHash] = await Promise.all([sha256(bundle), sha256(archive)]);
        const bundleKey = `${bundleHash}.js`;
        const sourceKey = `${archiveHash}.json`;

        if (idempotencyKey) {
          const existing = await versionByKey(bot.id, idempotencyKey);
          if (existing) return replay(bot, existing, bundleKey, sourceKey);
        }
        // Fail fast before uploading; the insert below re-checks atomically.
        const before = await quota(user.id);
        if (before.deploysToday >= limits.deploysPerDay) quotaExceeded(before);

        // Content-addressed, so a retry or a race rewrites identical bytes.
        await Promise.all([
          env.BUNDLES.put(bundleKey, bundle, {
            httpMetadata: { contentType: "text/javascript; charset=utf-8" },
            sha256: bundleHash,
          }),
          env.SOURCES.put(sourceKey, archive, {
            httpMetadata: { contentType: "application/json; charset=utf-8" },
            sha256: archiveHash,
          }),
        ]);

        const id = crypto.randomUUID();
        const createdAt = now().getTime();
        const meta = toMeta(body.meta);
        const dayStart = utcDayStart(now()).getTime();
        // Next `n` and the daily quota in one statement: D1 runs statements one at a time, so
        // concurrent deploys can't take the same `n` or squeeze past the quota.
        const inserted = await db.all<{ n: number }>(sql`
          INSERT INTO ${versions}
            (id, bot_id, n, status, bundle_key, source_key, meta, idempotency_key, created_at, updated_at)
          SELECT ${id}, ${bot.id},
            coalesce((SELECT max(n) FROM ${versions} WHERE bot_id = ${bot.id}), 0) + 1,
            'validating', ${bundleKey}, ${sourceKey}, ${meta && JSON.stringify(meta)},
            ${idempotencyKey}, ${createdAt}, ${createdAt}
          WHERE (
            SELECT count(*) FROM ${versions} AS v JOIN ${bots} AS b ON b.id = v.bot_id
            WHERE b.owner_id = ${user.id} AND v.created_at >= ${dayStart}
          ) < ${limits.deploysPerDay}
          ON CONFLICT DO NOTHING
          RETURNING n`);
        const n = inserted[0]?.n;
        if (n === undefined) {
          // A concurrent retry with the same key won, or the quota ran out meanwhile.
          if (idempotencyKey) {
            const existing = await versionByKey(bot.id, idempotencyKey);
            if (existing) return replay(bot, existing, bundleKey, sourceKey);
          }
          return quotaExceeded(await quota(user.id));
        }

        const job: CheckJob = {
          v: CHECK_JOB_VERSION,
          versionId: id,
          botId: bot.id,
          ownerId: user.id,
          n,
          bundleKey,
          sourceKey,
          enqueuedAt: Date.now(),
        };
        try {
          await env.CHECKS_QUEUE.send(job, { contentType: "json" });
        } catch (error) {
          // Without a job the version would sit in `validating` forever: undo it so a plain
          // retry works (and doesn't count against the quota).
          console.error("CHECKS_QUEUE.send failed", error);
          await db.delete(versions).where(eq(versions.id, id));
          fail(503, {
            error: "queue_unavailable",
            message: "Couldn't queue the checks, so nothing was deployed. Try again in a minute.",
          });
        }

        const [[version], after] = await Promise.all([
          db.select().from(versions).where(eq(versions.id, id)).limit(1),
          quota(user.id),
        ]);
        if (!version) throw new Error(`version ${id} vanished after insert`);
        return json(
          { version: versionInfo(bot, version), quota: after } satisfies DeployResponse,
          201,
          { location: `/api/bots/${bot.slug}/versions/${n}` },
        );
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
