import type { ApiErrorBody } from "@zerosnake/web/shared";
import { CliError } from "../errors.ts";
import { packageRoot, readJson } from "../paths.ts";
import { openBrowser } from "../sim/server.ts";
import { Credentials, configDir, DEFAULT_URL, type Env } from "./config.ts";

/** What the remote commands touch outside the process; tests pass fakes. */
export interface Remote {
  fetch: typeof fetch;
  env: Env;
  sleep(ms: number): Promise<void>;
  openBrowser(url: string): void;
  /** Unix ms. */
  now(): number;
}

export function defaultRemote(): Remote {
  return {
    fetch: globalThis.fetch,
    env: process.env,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    openBrowser,
    now: Date.now,
  };
}

export function credentials(remote: Remote): Credentials {
  return new Credentials(configDir(remote.env));
}

export function cliVersion(): string {
  return String(readJson(`${packageRoot()}/package.json`).version);
}

/** The server answered, with something other than 2xx (or with something that isn't JSON). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** The parsed body, if it was JSON. */
    readonly json: unknown,
    readonly path: string,
    /** How long the server asked to wait (`Retry-After`, else the body's `retryAfter`), if it did. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(`HTTP ${status} from ${path}`);
    this.name = "ApiError";
  }

  /** The CLI API's error body (`{ error, message }`), if that's what came back. */
  get body(): ApiErrorBody | null {
    const b = this.json as Partial<ApiErrorBody> | null;
    return b && typeof b.error === "string" && typeof b.message === "string"
      ? (b as ApiErrorBody)
      : null;
  }

  /** `error` of the body: an `ApiErrorCode`, or an OAuth one on the auth endpoints. */
  get code(): string | null {
    const b = this.json as { error?: unknown } | null;
    return b && typeof b.error === "string" ? b.error : null;
  }
}

/**
 * The server answered with a redirect. The CLI never follows one, so the token only ever goes to
 * the server it was issued by; a redirect means a wrong address or a misconfigured host, and
 * asking again won't help.
 */
export class RedirectError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    /** Where it pointed (absolute), if it said. */
    readonly location: string | null,
  ) {
    super(`HTTP ${status} redirect from ${path}${location ? ` to ${location}` : ""}`);
    this.name = "RedirectError";
  }
}

/** No answer: offline, DNS, refused, reset or timed out. Always safe to retry our requests. */
export class NetworkError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${path}: ${reason}`);
    this.name = "NetworkError";
  }
}

export interface CallOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** Default 30 s; a deploy upload gets longer. */
  timeoutMs?: number;
}

/** A JSON client for one server, with or without a CLI token. */
export class Api {
  constructor(
    readonly server: string,
    private readonly remote: Remote,
    private readonly token: string | null = null,
  ) {}

  get signedIn(): boolean {
    return this.token !== null;
  }

  async call<T>(method: "GET" | "POST", path: string, options: CallOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": `zerosnake/${cliVersion()} (node ${process.versions.node}; ${process.platform})`,
      ...options.headers,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";

    const url = `${this.server}${path}`;
    let response: Response;
    let text: string;
    try {
      // "manual", not "error": Node's fetch reports "error" as a failed connection, which looks
      // retryable and hides what happened.
      response = await this.remote.fetch(url, {
        method,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      if (isRedirect(response)) {
        await response.body?.cancel();
        text = "";
      } else {
        text = await response.text();
      }
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      const reason =
        (e as Error).name === "TimeoutError"
          ? "timed out"
          : (cause?.code ?? cause?.message ?? (e as Error).message);
      throw new NetworkError(path, reason);
    }
    if (isRedirect(response)) {
      throw new RedirectError(
        path,
        response.status,
        resolve(response.headers.get("location"), url),
      );
    }

    let json: unknown = null;
    const isJson = /^application\/json/i.test(response.headers.get("content-type") ?? "");
    if (isJson) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!response.ok || json === null) {
      const retryAfter =
        parseRetryAfter(response.headers.get("retry-after"), this.remote.now()) ??
        bodyRetryAfter(json);
      throw new ApiError(response.status, json, path, retryAfter);
    }
    return json as T;
  }
}

/** `Retry-After` (seconds, or an HTTP date) in ms from `now`; `null` if absent or malformed. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

function bodyRetryAfter(json: unknown): number | null {
  const seconds = (json as { retryAfter?: unknown } | null)?.retryAfter;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000
    : null;
}

function isRedirect(response: Response): boolean {
  return response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
}

function resolve(location: string | null, base: string): string | null {
  if (!location) return null;
  try {
    return new URL(location, base).href;
  } catch {
    return location;
  }
}

/**
 * Answers that look transient by status but come from an admin, not a hiccup: they last until a
 * person changes them (minutes to hours), so the CLI says so and stops instead of retrying.
 */
const ADMIN_STOPS = new Set(["deploys_paused", "arena_stopped"]);

/**
 * Worth trying again with the same request: no answer, a 5xx (the deploy API's 503 `unavailable`
 * and 500 `internal_error`, or a gateway's), 409 `deploy_in_progress`, or a 429 from a rate
 * limiter (not our `quota_exceeded`, which lasts until midnight). Not a 503 `deploys_paused` or
 * `arena_stopped`: an admin switched those on.
 */
export function isTransient(e: unknown): boolean {
  if (e instanceof NetworkError) return true;
  if (!(e instanceof ApiError)) return false;
  if (e.code !== null && ADMIN_STOPS.has(e.code)) return false;
  if (e.status >= 500) return true;
  if (e.status === 409) return e.code === "deploy_in_progress";
  if (e.status === 429) return e.code !== "quota_exceeded";
  return false;
}

export interface RetryOptions {
  /** Give up once this much time has been spent waiting between attempts. */
  maxWaitMs?: number;
  onRetry?(error: unknown, delayMs: number): void;
}

/**
 * Runs `fn` until it succeeds or fails with a non-transient error, backing off 1, 2, 4, 8, then
 * 10 s, or longer when the server asks for it (`Retry-After`). The default 90 s outlasts the
 * deploy API's one-minute takeover of a stuck deploy; when the server asks for a wait past it,
 * the error is thrown at once (its message says when to try again).
 */
export async function withRetries<T>(
  remote: Remote,
  fn: () => Promise<T>,
  { maxWaitMs = 90_000, onRetry }: RetryOptions = {},
): Promise<T> {
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const backoff = Math.min(1000 * 2 ** attempt, 10_000);
      const asked = e instanceof ApiError ? (e.retryAfterMs ?? 0) : 0;
      const delay = Math.max(backoff, asked);
      if (!isTransient(e) || waited + delay > maxWaitMs) throw e;
      onRetry?.(e, delay);
      await remote.sleep(delay);
      waited += delay;
    }
  }
}

/** The person isn't signed in to `server`. */
export function notLoggedIn(server: string): CliError {
  return new CliError(
    `You're not logged in to ${server}. Run \`zerosnake login${urlFlag(server)}\` first.`,
  );
}

/** ` --url <server>` when it isn't the one the CLI would pick anyway. */
export function urlFlag(server: string): string {
  return server === DEFAULT_URL ? "" : ` --url ${server}`;
}

/** An `Api` with the stored token (or `ZEROSNAKE_TOKEN`, for CI), or a "log in" error. */
export function signedInApi(server: string, remote: Remote): Api {
  const token = remote.env.ZEROSNAKE_TOKEN || credentials(remote).get(server)?.token;
  if (!token) throw notLoggedIn(server);
  return new Api(server, remote, token);
}

/**
 * Turns an API failure into what to tell the person: the server's `message` (written to be shown
 * as is) plus what to do about it. Anything else is rethrown.
 */
export function explain(e: unknown, server: string): CliError {
  if (e instanceof CliError) return e;
  if (e instanceof NetworkError) {
    return new CliError(
      `Couldn't reach ${server} (${e.reason}). Check your connection and try again.` +
        (server === DEFAULT_URL
          ? ""
          : `\nIs ${server} the right address? Pick another with --url or ZEROSNAKE_URL.`),
    );
  }
  if (e instanceof RedirectError) {
    return new CliError(
      `${server}${e.path} redirected (HTTP ${e.status}${e.location ? ` to ${e.location}` : ""}), and ` +
        "the CLI doesn't follow redirects: your login only goes to the server you picked.\n" +
        `Is ${server} the right address? Pick another with --url or ZEROSNAKE_URL. ` +
        "If it is, the server is misconfigured.",
    );
  }
  if (!(e instanceof ApiError)) throw e;
  const body = e.body;
  if (!body) {
    if (e.status === 401) return expired(server);
    if (e.status === 429)
      return new CliError("The server is busy (HTTP 429). Wait a minute and try again.");
    if (e.status >= 500) {
      return new CliError(`${server} is having trouble (HTTP ${e.status}). Try again in a minute.`);
    }
    return new CliError(
      `Unexpected answer from ${server}${e.path} (HTTP ${e.status}). Is this a ZeroSnake server, ` +
        "and is your CLI up to date? (`npx zerosnake@latest`)",
    );
  }
  const hint = HINTS[body.error];
  switch (body.error) {
    case "unauthorized":
      return expired(server);
    case "quota_exceeded":
      return new CliError(
        body.quota
          ? `You've used all ${body.quota.deploysPerDay} deploys for today. More at ${localTime(body.quota.resetsAt)} (00:00 UTC).`
          : body.message,
      );
    default:
      return new CliError(hint ? `${body.message}\n${hint}` : body.message);
  }
}

function expired(server: string): CliError {
  return new CliError(
    `${server} didn't accept your login: it expired or was revoked. Run \`zerosnake login${urlFlag(server)}\` again.`,
  );
}

const HINTS: Partial<Record<string, string>> = {
  bundle_too_large:
    "Bundles include everything your bot imports: drop big tables or dependencies you don't use.",
  sources_too_large: "Everything under src/ is uploaded: move data files and notes out of src/.",
  too_many_files:
    "Everything under src/ is uploaded: merge small files or move extras out of src/.",
  invalid_path: "Rename the file: letters, digits and . _ - @ + only.",
  duplicate_path: "Two files differ only in letter case; rename one.",
  body_too_large: "Your sources and bundle together are too big to upload.",
  not_bot_owner: "Pick one of your own bots with --bot (`zerosnake status` lists them).",
  bot_limit_reached: "Archive a bot on the site, or deploy to an existing one with --bot.",
  unavailable: "Nothing was deployed. Try again in a minute.",
  deploys_paused:
    "The server's admins paused deploys for everyone; it isn't about your bot. Deploy again later.",
  arena_stopped:
    "The server's admins stopped the arena for everyone; it isn't about your bot. Try again later.",
  internal_error: "If it keeps failing, please report it.",
};

/** `2026-10-28T00:00:00.000Z` → `01:00` in the person's time zone (with the date if not today). */
export function localTime(iso: string, now = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return at.toDateString() === now.toDateString()
    ? time
    : `${at.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}
