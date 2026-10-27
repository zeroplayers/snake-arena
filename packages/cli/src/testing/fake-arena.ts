import type {
  ApiErrorBody,
  BotInfo,
  CheckReport,
  DeployLimits,
  DeployRequest,
  MeResponse,
  VersionInfo,
  VersionStatus,
} from "@zerosnake/web/shared";
import { DEPLOY_LIMITS } from "@zerosnake/web/shared";
import type { Remote } from "../remote/api.ts";

export const SERVER = "https://arena.test";

/**
 * What the fake does instead, once, for the next request matching a method and path: answer
 * this, fail without reaching the server (`network`), or handle it and lose the answer (`lost`).
 */
type Fault = Response | "network" | "lost";

interface FakeVersion {
  info: VersionInfo;
  key: string | null;
  /** Polls left before the checks "finish". */
  pollsLeft: number;
  outcome: { status: VersionStatus; report: CheckReport };
}

/**
 * The site's CLI-facing endpoints, in memory, as a `fetch`: the device flow under `/api/auth`,
 * the CLI API and the public profile. Enough state to drive the commands through their paths,
 * plus fault injection for the error shapes.
 */
export class FakeArena {
  username: string | null = "ada";
  bots: BotInfo[] = [];
  versions: FakeVersion[] = [];
  deploysToday = 0;
  deploysPerDay: number = DEPLOY_LIMITS.deploysPerDay;
  /** What `GET /api/me` reports as the server's limits. */
  limits: DeployLimits = { ...DEPLOY_LIMITS };
  /** Tokens the server accepts. */
  tokens = new Set<string>();
  revoked: string[] = [];
  /** What the checks decide for the next deploys, and after how many polls. */
  outcome: { status: VersionStatus; report: CheckReport; polls: number } = {
    status: "ready",
    report: { ok: true, checks: [{ name: "loads", ok: true }], qualificationScore: 42 },
    polls: 2,
  };
  /** Device flow: answers for successive token polls, then `approved`. */
  devicePolls: string[] = ["authorization_pending"];
  /** `false` = the server has no lives endpoint yet (the site's HTML 404). */
  livesEndpoint = false;
  lives: unknown[] = [];
  ratings: Record<string, { rating: number; ratingCi: number; ratedLives: number; lives: number }> =
    {};
  requests: { method: string; path: string; headers: Headers; body: unknown }[] = [];
  private faults: { method: string; path: RegExp; fault: Fault }[] = [];
  private issued = 0;

  /** The next request to `method path` gets `fault` instead. */
  fail(method: string, path: RegExp, fault: Fault): this {
    this.faults.push({ method, path, fault });
    return this;
  }

  /** Requests to `method path` so far. */
  calls(method: string, path: RegExp) {
    return this.requests.filter((r) => r.method === method && path.test(r.path));
  }

  addBot(slug: string): BotInfo {
    const bot = { id: `bot-${slug}`, slug, name: slug, createdAt: "2026-10-01T00:00:00.000Z" };
    this.bots.push(bot);
    return bot;
  }

  /** A `Remote` with this server, the env given, no real waiting and no browser. */
  remote(env: Record<string, string | undefined> = {}, opened: string[] = []): Remote {
    let clock = Date.parse("2026-10-27T12:00:00Z");
    return {
      fetch: (input, init) => this.handle(input, init),
      env: { ZEROSNAKE_URL: SERVER, ...env },
      sleep: async (ms) => {
        clock += ms;
      },
      openBrowser: (url) => opened.push(url),
      now: () => clock,
    };
  }

  private async handle(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input.toString());
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, path: url.pathname + url.search, headers, body });

    const fault = this.faults.find((f) => f.method === method && f.path.test(url.pathname));
    if (fault) {
      this.faults.splice(this.faults.indexOf(fault), 1);
      if (fault.fault === "lost") this.route(method, url, headers, body);
      if (fault.fault === "network" || fault.fault === "lost") {
        throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      }
      return fault.fault;
    }
    return this.route(method, url, headers, body);
  }

  private route(method: string, url: URL, headers: Headers, body: unknown): Response {
    const path = url.pathname;
    const token = /^Bearer (\S+)$/.exec(headers.get("authorization") ?? "")?.[1];
    const authed = token !== undefined && this.tokens.has(token);
    const route = `${method} ${path}`;

    if (route === "POST /api/auth/device/code") {
      return Response.json({
        device_code: "device-123",
        user_code: "WXYZ-1234",
        verification_uri: `${SERVER}/device`,
        verification_uri_complete: `${SERVER}/device?user_code=WXYZ-1234`,
        expires_in: 600,
        interval: 5,
      });
    }
    if (route === "POST /api/auth/cli/token") {
      const next = this.devicePolls.shift();
      if (next) return Response.json({ error: next, error_description: next }, { status: 400 });
      const issued = `zsk_secret${++this.issued}`;
      this.tokens.add(issued);
      return Response.json({
        access_token: issued,
        token_type: "Bearer",
        expires_in: 1,
        scope: "",
      });
    }
    if (route === "GET /api/auth/cli/me" && authed) {
      return Response.json({
        tokenId: "t",
        user: { id: "u1", username: this.username, name: "Ada" },
      });
    }
    if (route === "POST /api/auth/cli/logout" && authed && token) {
      this.tokens.delete(token);
      this.revoked.push(token);
      return Response.json({ status: true });
    }
    if (path.startsWith("/api/auth/"))
      return Response.json({ message: "Unauthorized" }, { status: 401 });

    const users = /^\/api\/users\/([^/]+)$/.exec(path);
    if (method === "GET" && users) {
      return Response.json({
        username: users[1],
        bots: this.bots.map((b) => ({
          slug: b.slug,
          activeVersion: this.active(b)?.info.n ?? null,
          rating: null,
          ratingCi: null,
          ratedLives: null,
          lives: 0,
          ...this.ratings[b.slug],
        })),
      });
    }

    if (!path.startsWith("/api/") || !/^\/api\/(me|bots)(\/|$)/.test(path)) return htmlNotFound();
    if (!authed) return apiError(401, "unauthorized", "Missing, expired or revoked CLI token.");

    if (route === "GET /api/me") {
      return Response.json({
        user: { id: "u1", username: this.username, name: "Ada", image: null },
        bots: this.bots.map((b) => {
          const latest = this.versions.filter((v) => v.info.bot.id === b.id).at(-1)?.info;
          return {
            ...b,
            archived: false,
            activeVersion: this.active(b)?.info.n ?? null,
            latestVersion: latest
              ? { n: latest.n, status: latest.status, createdAt: latest.createdAt }
              : null,
          };
        }),
        quota: this.quota(),
        limits: this.limits,
      } satisfies MeResponse);
    }
    if (route === "POST /api/bots") {
      const { name, slug } = body as { name: string; slug: string };
      const existing = this.bots.find((b) => b.slug === slug);
      if (existing)
        return apiError(409, "bot_exists", `You already have a bot "${slug}".`, { bot: existing });
      const bot = this.addBot(slug);
      bot.name = name;
      return Response.json(bot, { status: 201 });
    }

    const versions = /^\/api\/bots\/([^/]+)\/versions(?:\/(\d+))?(\/lives)?$/.exec(path);
    const bot = versions && this.bots.find((b) => b.slug === versions[1]);
    if (!versions) return htmlNotFound();
    if (!bot) return apiError(404, "bot_not_found", `You have no bot "${versions[1]}".`);
    if (method === "POST" && !versions[2]) return this.deploy(bot, headers, body as DeployRequest);
    const v = this.versions.find(
      (x) => x.info.bot.id === bot.id && x.info.n === Number(versions[2]),
    );
    if (!v)
      return apiError(404, "version_not_found", `Bot "${bot.slug}" has no version ${versions[2]}.`);
    if (versions[3])
      return this.livesEndpoint ? Response.json({ lives: this.lives }) : htmlNotFound();
    if (method === "GET") {
      if (v.info.status === "validating" && --v.pollsLeft <= 0) {
        for (const other of this.versions) {
          if (other.info.bot.id === bot.id && other.info.status === "ready")
            other.info.status = "archived";
        }
        v.info.status = v.outcome.status;
        v.info.report = v.outcome.report;
      }
      return Response.json(v.info);
    }
    return htmlNotFound();
  }

  private deploy(bot: BotInfo, headers: Headers, body: DeployRequest): Response {
    const key = headers.get("idempotency-key");
    const replay = key && this.versions.find((v) => v.key === key && v.info.bot.id === bot.id);
    if (replay) return Response.json({ version: replay.info, quota: this.quota() });
    if (this.deploysToday >= this.deploysPerDay) {
      return apiError(429, "quota_exceeded", "You've used all your deploys.", {
        quota: this.quota(),
      });
    }
    this.deploysToday++;
    const n = this.versions.filter((v) => v.info.bot.id === bot.id).length + 1;
    const info: VersionInfo = {
      id: `v-${bot.slug}-${n}`,
      bot: { id: bot.id, slug: bot.slug },
      n,
      status: "validating",
      report: null,
      meta: body.meta ?? null,
      createdAt: "2026-10-27T11:59:00.000Z",
      updatedAt: "2026-10-27T11:59:00.000Z",
    };
    const { polls, ...outcome } = this.outcome;
    this.versions.push({ info, key, pollsLeft: polls, outcome });
    return Response.json({ version: info, quota: this.quota() }, { status: 201 });
  }

  private active(bot: BotInfo) {
    return this.versions.find((v) => v.info.bot.id === bot.id && v.info.status === "ready");
  }

  private quota() {
    return {
      deploysToday: this.deploysToday,
      deploysPerDay: this.deploysPerDay,
      resetsAt: "2026-10-28T00:00:00.000Z",
    };
  }
}

export function apiError(
  status: number,
  error: ApiErrorBody["error"] | string,
  message: string,
  extra: Partial<ApiErrorBody> = {},
): Response {
  return Response.json({ error, message, ...extra }, { status });
}

/** What the site answers for a path no route handles: its HTML not-found page. */
export function htmlNotFound(): Response {
  return new Response("<!doctype html><title>Not found</title>", {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
