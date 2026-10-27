/**
 * Request and response shapes of the CLI API (`/api/me`, `/api/bots`, `/api/bots/:bot/versions`),
 * for `zerosnake deploy` / `status`. Every endpoint takes `Authorization: Bearer zsk_…` (a CLI
 * token from `zerosnake login`) and nothing else; browser sessions get 401.
 *
 * Errors are `ApiErrorBody` with a stable `error` code and a `message` meant to be shown as is.
 */
import type { VersionQuarantine } from "./arena";
import type { CheckReport, SourceFile } from "./checks";

export const versionStatuses = ["validating", "ready", "rejected", "archived"] as const;
export type VersionStatus = (typeof versionStatuses)[number];

const KiB = 1024;
const MiB = 1024 * KiB;

/** Defaults; the daily quota and the bot limit can be changed per environment (wrangler vars). */
export const DEPLOY_LIMITS = {
  /** Source files per version. */
  maxSourceFiles: 50,
  /** Sum of the source files' UTF-8 sizes. */
  maxSourceBytes: 1 * MiB,
  /** UTF-8 size of the bundle. */
  maxBundleBytes: 256 * KiB,
  /** Length of one source path. */
  maxPathLength: 200,
  /** The whole request body, JSON escaping included. */
  maxBodyBytes: 3 * MiB,
  /**
   * Deploys per author per UTC day (`DEPLOYS_PER_DAY`). Versions the checks reject count; deploys
   * that failed with 503 before being queued don't. Rollbacks on the site count too (a rollback
   * restarts the version's rating, see `src/server/quota.ts`).
   */
  deploysPerDay: 20,
  /** Active bots per author (`BOTS_PER_AUTHOR`); archived ones don't count. */
  botsPerAuthor: 3,
} as const;

export type DeployLimits = { [K in keyof typeof DEPLOY_LIMITS]: number };

// ─── Requests ────────────────────────────────────────────────────────────────────────────────────

/** `POST /api/bots`. `slug` defaults to `name` lowercased with runs of other characters → `-`. */
export interface CreateBotRequest {
  name: string;
  slug?: string;
}

/**
 * `POST /api/bots/:bot/versions`, `Content-Type: application/json`. `:bot` is the slug (or id) of
 * one of the caller's bots.
 *
 * Optional `Idempotency-Key` header (8–128 of `[A-Za-z0-9_-]`, e.g. a UUID per `zerosnake deploy`
 * run, reused for its retries):
 * - once the first attempt's version is queued, a retry returns it (200 instead of 201) without
 *   using quota or queueing it again;
 * - while the first attempt is still running, 409 `deploy_in_progress`: wait a little and retry;
 * - if the first attempt failed (503), the key is free again and a retry deploys anew;
 * - the same key with different content is a 409 `idempotency_conflict`.
 */
export interface DeployRequest {
  /** The bundle: a single ESM file, as text. */
  bundle: string;
  /**
   * The bot's source files as text, paths relative to the project root with `/` separators.
   * No `.`/`..` segments, absolute paths or backslashes; symlinks have no representation, so the
   * CLI should skip them (or refuse) rather than follow them.
   */
  sources: SourceFile[];
  meta?: DeployMeta;
}

export interface DeployMeta {
  cliVersion?: string;
  sdkVersion?: string;
  /** Free text, like a commit message (≤ 200 characters). */
  message?: string;
}

// ─── Responses ───────────────────────────────────────────────────────────────────────────────────

export interface BotInfo {
  id: string;
  slug: string;
  name: string;
  /** ISO 8601. */
  createdAt: string;
}

/** `POST /api/bots` → 201. */
export type CreateBotResponse = BotInfo;

/** `GET /api/bots/:bot/versions/:n`. */
export interface VersionInfo {
  id: string;
  bot: { id: string; slug: string };
  n: number;
  status: VersionStatus;
  /** Written by the checks consumer; `null` while `validating`. */
  report: CheckReport | null;
  meta: DeployMeta | null;
  /**
   * Set when the arena quarantined the version (`src/shared/arena.ts`, "Quarantine"): still
   * `ready`, but it gets no new lives. Missing from older servers.
   */
  quarantine?: VersionQuarantine | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuotaInfo {
  deploysToday: number;
  deploysPerDay: number;
  /** Next UTC midnight, ISO 8601. */
  resetsAt: string;
}

/** `POST /api/bots/:bot/versions` → 201 (new) or 200 (idempotent retry). */
export interface DeployResponse {
  version: VersionInfo;
  quota: QuotaInfo;
}

/** `GET /api/me`, for `zerosnake status`. */
export interface MeResponse {
  user: { id: string; username: string | null; name: string; image: string | null };
  bots: (BotInfo & {
    /** Archived on the site: can't be deployed to until restored there. */
    archived: boolean;
    /** `n` of the `ready` version, if any. */
    activeVersion: number | null;
    /** The `ready` version's quarantine, if the arena quarantined it. Missing from older servers. */
    activeQuarantine?: VersionQuarantine | null;
    latestVersion: { n: number; status: VersionStatus; createdAt: string } | null;
  })[];
  quota: QuotaInfo;
  limits: DeployLimits;
}

// ─── Errors ──────────────────────────────────────────────────────────────────────────────────────

export type ApiErrorCode =
  /** 401: no `Authorization: Bearer zsk_…`, or the token is unknown, expired or revoked. */
  | "unauthorized"
  /** 415: body isn't `application/json`. */
  | "unsupported_media_type"
  /** 400: body isn't JSON, or doesn't match the request shape (`message` says where). */
  | "invalid_request"
  /** 413: body over `maxBodyBytes`. */
  | "body_too_large"
  /** 422: deploy limits. `limit` and `actual` give the numbers. */
  | "bundle_too_large"
  | "sources_too_large"
  | "too_many_files"
  /** 422: a bad source path; `path` is the offending one. */
  | "invalid_path"
  | "duplicate_path"
  /** 422: bot name/slug rules. */
  | "invalid_bot_name"
  /** 404 */
  | "bot_not_found"
  | "version_not_found"
  /** 404: `GET /api/lives/:id/trace` for a life that doesn't exist. */
  | "life_not_found"
  /** 404: the life has no trace (none was recorded). */
  | "trace_not_found"
  /** 410: the life's trace was deleted after `TRACE_RETENTION_DAYS` (`src/shared/trace.ts`). */
  | "trace_expired"
  /** 403: `:bot` is someone else's. */
  | "not_bot_owner"
  /** 403: the life is someone else's bot's (traces are private to the bot's owner). */
  | "not_life_owner"
  /** 409: `POST /api/bots` with a slug the caller already uses; `bot` is the existing one. */
  | "bot_exists"
  /** 403: already at `botsPerAuthor` active (not archived) bots. */
  | "bot_limit_reached"
  /** 409: deploying to a bot archived on the site; `bot` is the bot. */
  | "bot_archived"
  /** 429: `deploysPerDay` used up; `quota` says when it resets. */
  | "quota_exceeded"
  /**
   * 429: too many requests in a short time (`src/server/rate-limit.ts`); retry after
   * `retryAfter` seconds (also the `Retry-After` header). Unlike `quota_exceeded`, it passes soon.
   */
  | "rate_limited"
  /** 403: the caller's account is suspended by an admin; `message` says why. */
  | "user_banned"
  /** 403: deploying to a bot an admin banned; `bot` is the bot. */
  | "bot_banned"
  /** 503: an admin paused deploys (the kill switch); try again later. */
  | "deploys_paused"
  /** 409: `Idempotency-Key` reused for different content. */
  | "idempotency_conflict"
  /** 409: an earlier request with this `Idempotency-Key` is still running; retry shortly. */
  | "deploy_in_progress"
  /** 503: storing or queueing failed; nothing was deployed (that version is `rejected`). Retry. */
  | "unavailable"
  /** 500: anything unexpected. */
  | "internal_error";

export interface ApiErrorBody {
  error: ApiErrorCode;
  message: string;
  limit?: number;
  actual?: number;
  path?: string;
  quota?: QuotaInfo;
  bot?: BotInfo;
  /** Seconds to wait before retrying (`rate_limited`), same as the `Retry-After` header. */
  retryAfter?: number;
}
