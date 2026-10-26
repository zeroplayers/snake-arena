/**
 * Request and response shapes of the CLI API (`/api/me`, `/api/bots`, `/api/bots/:bot/versions`),
 * for `zerosnake deploy` / `status`. Every endpoint takes `Authorization: Bearer zsk_…` (a CLI
 * token from `zerosnake login`) and nothing else; browser sessions get 401.
 *
 * Errors are `ApiErrorBody` with a stable `error` code and a `message` meant to be shown as is.
 */
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
  /** Deploys per author per UTC day, rejected ones included (`DEPLOYS_PER_DAY`). */
  deploysPerDay: 20,
  /** Bots per author (`BOTS_PER_AUTHOR`). */
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
 * run): a retry with the same key and the same content returns the version the first attempt made
 * (200 instead of 201) and doesn't count against the quota. The same key with different content
 * is a 409 `idempotency_conflict`.
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
    /** `n` of the `ready` version, if any. */
    activeVersion: number | null;
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
  /** 403: `:bot` is someone else's. */
  | "not_bot_owner"
  /** 409: `POST /api/bots` with a slug the caller already uses; `bot` is the existing one. */
  | "bot_exists"
  /** 403: already at `botsPerAuthor`. */
  | "bot_limit_reached"
  /** 429: `deploysPerDay` used up; `quota` says when it resets. */
  | "quota_exceeded"
  /** 409: `Idempotency-Key` reused for different content. */
  | "idempotency_conflict"
  /** 503: the checks queue refused the job; nothing was stored as a version, retry. */
  | "queue_unavailable";

export interface ApiErrorBody {
  error: ApiErrorCode;
  message: string;
  limit?: number;
  actual?: number;
  path?: string;
  quota?: QuotaInfo;
  bot?: BotInfo;
}
