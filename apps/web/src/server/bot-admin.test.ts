import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveVersionChange } from "../shared";
import { createTestD1, type TestD1 } from "../test/d1";
import { CookieJar, type FakeGithubUser, mockGithub } from "../test/github";
import { type Auth, createAuth } from "./auth";
import {
  type AdminResult,
  type BotAdminLimits,
  createBotAdmin,
  type ManagedBot,
  matchmakerNotifier,
} from "./bot-admin";
import { hashToken } from "./cli-auth";

const BASE = "http://localhost:3000";

let d1: TestD1;
let auth: Auth;
let clock: Date;
let notified: ActiveVersionChange[];

beforeEach(async () => {
  d1 = await createTestD1();
  auth = createAuth({
    DB: d1.db,
    BETTER_AUTH_URL: BASE,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    GITHUB_CLIENT_ID: "test-client-id",
    GITHUB_CLIENT_SECRET: "test-client-secret",
  });
  clock = new Date("2026-10-26T12:00:00Z");
  notified = [];
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await d1.dispose();
});

function admin(limits: Partial<BotAdminLimits> = {}) {
  return createBotAdmin(
    { DB: d1.db, BETTER_AUTH_URL: BASE },
    {
      getSession: (input) => auth.api.getSession(input),
      notify: async (change) => {
        notified.push(change);
      },
      now: () => clock,
      limits,
    },
  );
}

// ─── Fixtures ────────────────────────────────────────────────────────────────────────────────────

interface Author {
  id: string;
  jar: CookieJar;
}

let githubIds = 0;

/** Signs in with (fake) GitHub and claims `login` as username: a real web session cookie. */
async function signUp(login: string): Promise<Author> {
  const user: FakeGithubUser = {
    id: ++githubIds,
    login,
    name: login,
    email: `${login}@example.com`,
  };
  mockGithub(user);
  const jar = new CookieJar();
  const start = await auth.handler(
    new Request(`${BASE}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ provider: "github", callbackURL: "/welcome" }),
    }),
  );
  jar.store(start);
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state");
  jar.store(
    await auth.handler(
      new Request(`${BASE}/api/auth/callback/github?code=c&state=${state}`, {
        headers: { cookie: jar.header() },
      }),
    ),
  );
  const claim = await auth.handler(
    new Request(`${BASE}/api/auth/username/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, cookie: jar.header() },
      body: JSON.stringify({ username: login }),
    }),
  );
  expect(claim.status).toBe(200);
  const row = await d1.db
    .prepare("SELECT id FROM users WHERE username = ?")
    .bind(login)
    .first<{ id: string }>();
  if (!row) throw new Error("sign-up failed");
  vi.unstubAllGlobals();
  return { id: row.id, jar };
}

interface RequestOptions {
  /** `Origin` header; the site's own by default, `null` to omit it. */
  origin?: string | null;
  bearer?: string;
  headers?: Record<string, string>;
}

/** What a server function call looks like: a POST to the site with the session cookie. */
function req(author: Author | null, { origin = BASE, bearer, headers = {} }: RequestOptions = {}) {
  const h = new Headers(headers);
  if (author) h.set("cookie", author.jar.header());
  if (origin) h.set("origin", origin);
  if (bearer) h.set("authorization", `Bearer ${bearer}`);
  return new Request(`${BASE}/_serverFn/manage`, { method: "POST", headers: h });
}

function ok<T>(result: AdminResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}: ${result.message}`);
  return result.value;
}

function expectError<T>(result: AdminResult<T>, error: string) {
  expect(result).toMatchObject({ ok: false, error });
  if (result.ok) throw new Error("unreachable");
  expect(result.message).toEqual(expect.any(String));
  return result;
}

async function createBot(author: Author, name: string) {
  return ok(await admin().createBot(req(author), { name }));
}

type Status = "validating" | "ready" | "rejected" | "archived";

async function addVersion(
  botId: string,
  n: number,
  status: Status,
  { report, rating }: { report?: object; rating?: { mean: number; ci: number } } = {},
) {
  const id = `${botId}-v${n}`;
  await d1.db
    .prepare(
      `INSERT INTO versions (id, bot_id, n, status, bundle_key, source_key, report, enqueued_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'b.js', 's.json', ?, ?, ?, ?)`,
    )
    .bind(
      id,
      botId,
      n,
      status,
      report ? JSON.stringify(report) : null,
      clock.getTime(),
      clock.getTime() - 86_400_000,
      clock.getTime() - 86_400_000,
    )
    .run();
  if (rating) {
    await d1.db
      .prepare("INSERT INTO ratings (version_id, mean, ci, n_lives) VALUES (?, ?, ?, 40)")
      .bind(id, rating.mean, rating.ci)
      .run();
  }
  return id;
}

async function statuses(botId: string) {
  const { results } = await d1.db
    .prepare("SELECT n, status FROM versions WHERE bot_id = ? ORDER BY n")
    .bind(botId)
    .all<{ n: number; status: Status }>();
  return Object.fromEntries(results.map((r) => [r.n, r.status]));
}

async function readyVersions(botId: string) {
  const { results } = await d1.db
    .prepare("SELECT id FROM versions WHERE bot_id = ? AND status = 'ready'")
    .bind(botId)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

async function overview(author: Author) {
  return ok(await admin().overview(req(author)));
}

async function managed(author: Author, botId: string): Promise<ManagedBot> {
  const bot = (await overview(author)).bots.find((b) => b.id === botId);
  if (!bot) throw new Error(`bot ${botId} not listed`);
  return bot;
}

// ─── Auth ────────────────────────────────────────────────────────────────────────────────────────

describe("auth", () => {
  it("needs a web session", async () => {
    expectError(await admin().overview(req(null)), "unauthorized");
    expectError(await admin().createBot(req(null), { name: "x" }), "unauthorized");
  });

  it("rejects CLI tokens, even valid ones", async () => {
    const ada = await signUp("ada");
    const token = `zsk_${crypto.randomUUID()}`;
    await d1.db
      .prepare("INSERT INTO cli_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
      .bind(crypto.randomUUID(), ada.id, await hashToken(token), Date.now() + 86_400_000)
      .run();
    const bot = await createBot(ada, "Mine");
    const cli = req(null, { bearer: token, origin: null });

    expectError(await admin().overview(cli), "unauthorized");
    expectError(
      await admin().createBot(req(null, { bearer: token }), { name: "x" }),
      "unauthorized",
    );
    expectError(
      await admin().archiveBot(req(null, { bearer: token }), { botId: bot.id }),
      "unauthorized",
    );
    expect((await managed(ada, bot.id)).archivedAt).toBeNull();
  });

  it("refuses changes from other origins, with or without a session", async () => {
    const ada = await signUp("ada");
    expectError(
      await admin().createBot(req(ada, { origin: "https://evil.example" }), { name: "x" }),
      "forbidden_origin",
    );
    expectError(
      await admin().createBot(req(ada, { origin: null }), { name: "x" }),
      "forbidden_origin",
    );
    expectError(
      await admin().createBot(
        req(ada, { origin: null, headers: { "sec-fetch-site": "cross-site" } }),
        { name: "x" },
      ),
      "forbidden_origin",
    );
    expect((await overview(ada)).bots).toEqual([]);
    // Same-origin requests without `Origin` pass on `Sec-Fetch-Site`.
    ok(
      await admin().createBot(
        req(ada, { origin: null, headers: { "sec-fetch-site": "same-origin" } }),
        { name: "x" },
      ),
    );
  });

  it("reads need no origin", async () => {
    const ada = await signUp("ada");
    expect(ok(await admin().overview(req(ada, { origin: null })))).toMatchObject({
      username: "ada",
    });
  });
});

// ─── Ownership ───────────────────────────────────────────────────────────────────────────────────

describe("ownership", () => {
  it("never lets one author touch another's bots or versions", async () => {
    const ada = await signUp("ada");
    const bob = await signUp("bob");
    const bot = await createBot(ada, "Ada Bot");
    const v1 = await addVersion(bot.id, 1, "archived");
    const v2 = await addVersion(bot.id, 2, "ready");

    expectError(
      await admin().renameBot(req(bob), { botId: bot.id, name: "pwned" }),
      "bot_not_found",
    );
    expectError(await admin().archiveBot(req(bob), { botId: bot.id }), "bot_not_found");
    expectError(await admin().restoreBot(req(bob), { botId: bot.id }), "bot_not_found");
    expectError(await admin().activateVersion(req(bob), { versionId: v1 }), "version_not_found");
    expectError(await admin().archiveVersion(req(bob), { versionId: v2 }), "version_not_found");
    // Same answers as for ids that don't exist.
    expectError(await admin().archiveBot(req(bob), { botId: "nope" }), "bot_not_found");
    expectError(
      await admin().activateVersion(req(bob), { versionId: "nope" }),
      "version_not_found",
    );

    expect((await overview(bob)).bots).toEqual([]);
    const own = await managed(ada, bot.id);
    expect(own).toMatchObject({ name: "Ada Bot", archivedAt: null, activeVersion: { id: v2 } });
    expect(await statuses(bot.id)).toEqual({ 1: "archived", 2: "ready" });
    expect(notified).toEqual([]);
  });
});

// ─── Bots ────────────────────────────────────────────────────────────────────────────────────────

describe("create and rename", () => {
  it("makes a URL-safe slug from the name and keeps it on rename", async () => {
    const ada = await signUp("ada");
    const bot = await createBot(ada, "  Sneaky Snake 2000!  ");
    expect(bot.slug).toBe("sneaky-snake-2000");

    const renamed = ok(await admin().renameBot(req(ada), { botId: bot.id, name: "Sneakier" }));
    expect(renamed).toEqual({ id: bot.id, name: "Sneakier", slug: "sneaky-snake-2000" });
    // The old slug is still the bot's, so a new bot can't take it over.
    expectError(await admin().createBot(req(ada), { name: "Sneaky Snake 2000" }), "bot_exists");
  });

  it("takes an explicit slug and checks names", async () => {
    const ada = await signUp("ada");
    expect(ok(await admin().createBot(req(ada), { name: "Whatever", slug: "Hunter-1" })).slug).toBe(
      "hunter-1",
    );
    for (const input of [
      { name: "" },
      { name: "x".repeat(41) },
      { name: "!!!" },
      { name: "ok", slug: "-x" },
    ]) {
      expectError(await admin().createBot(req(ada), input), "invalid_bot_name");
    }
    const bot = await createBot(ada, "Fine");
    expectError(
      await admin().renameBot(req(ada), { botId: bot.id, name: " " }),
      "invalid_bot_name",
    );
    expectError(
      await admin().renameBot(req(ada), { botId: bot.id, name: "a\u0007b" }),
      "invalid_bot_name",
    );
  });

  it("allows 3 active bots per author, also under concurrency", async () => {
    const ada = await signUp("ada");
    const results = await Promise.all(
      ["a", "b", "c", "d", "e", "f"].map((name) => admin().createBot(req(ada), { name })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    for (const r of results.filter((r) => !r.ok)) expectError(r, "bot_limit_reached");
    expect((await overview(ada)).activeBots).toBe(3);
  });
});

describe("archive and restore", () => {
  it("frees a slot, keeps the slug taken, and restores within the limit", async () => {
    const ada = await signUp("ada");
    const [a, b] = [await createBot(ada, "a"), await createBot(ada, "b")];
    await createBot(ada, "c");
    expectError(await admin().createBot(req(ada), { name: "d" }), "bot_limit_reached");

    ok(await admin().archiveBot(req(ada), { botId: a.id }));
    expectError(await admin().archiveBot(req(ada), { botId: a.id }), "bot_archived");
    const exists = expectError(await admin().createBot(req(ada), { name: "a" }), "bot_exists");
    expect(exists.message).toMatch(/archived/);
    await createBot(ada, "d");

    expectError(await admin().restoreBot(req(ada), { botId: a.id }), "bot_limit_reached");
    ok(await admin().archiveBot(req(ada), { botId: b.id }));
    ok(await admin().restoreBot(req(ada), { botId: a.id }));
    expectError(await admin().restoreBot(req(ada), { botId: a.id }), "bot_not_archived");

    const page = await overview(ada);
    expect(page.activeBots).toBe(3);
    // Active bots first, then archived ones.
    expect(page.bots.map((bot) => [bot.slug, bot.archivedAt !== null])).toEqual([
      ["a", false],
      ["c", false],
      ["d", false],
      ["b", true],
    ]);
  });

  it("restores only up to the limit when restores race", async () => {
    const ada = await signUp("ada");
    const bots = [];
    for (const name of ["a", "b", "c"]) bots.push(await createBot(ada, name));
    for (const bot of bots) ok(await admin().archiveBot(req(ada), { botId: bot.id }));
    await createBot(ada, "d");
    await createBot(ada, "e");
    const results = await Promise.all(
      bots.map((bot) => admin().restoreBot(req(ada), { botId: bot.id })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await overview(ada)).activeBots).toBe(3);
  });

  it("takes the active version out of play and rejects versions still in checks", async () => {
    const ada = await signUp("ada");
    const bot = await createBot(ada, "a");
    await addVersion(bot.id, 1, "archived");
    const v2 = await addVersion(bot.id, 2, "ready");
    await addVersion(bot.id, 3, "validating");
    await addVersion(bot.id, 4, "rejected");

    const { change } = ok(await admin().archiveBot(req(ada), { botId: bot.id }));
    expect(change).toEqual({
      v: 1,
      botId: bot.id,
      ownerId: ada.id,
      reason: "archive_bot",
      versionId: null,
      previousVersionId: v2,
      changedAt: clock.getTime(),
    });
    expect(notified).toEqual([change]);
    expect(await statuses(bot.id)).toEqual({
      1: "archived",
      2: "archived",
      3: "rejected",
      4: "rejected",
    });
    const archived = await managed(ada, bot.id);
    expect(archived).toMatchObject({ archivedAt: clock.toISOString(), activeVersion: null });
    expect(archived.versions.find((v) => v.n === 3)?.problems).toEqual([
      "Deploy: The bot was archived before the checks ended.",
    ]);
    expect(archived.versions.every((v) => !v.canActivate)).toBe(true);

    // No rollbacks on an archived bot; after a restore it has no active version until one is picked.
    expectError(await admin().activateVersion(req(ada), { versionId: v2 }), "bot_archived");
    ok(await admin().restoreBot(req(ada), { botId: bot.id }));
    expect(await managed(ada, bot.id)).toMatchObject({ archivedAt: null, activeVersion: null });
    ok(await admin().activateVersion(req(ada), { versionId: v2 }));
    expect(await readyVersions(bot.id)).toEqual([v2]);
  });

  it("doesn't notify the matchmaker when nothing was playing", async () => {
    const ada = await signUp("ada");
    const bot = await createBot(ada, "a");
    ok(await admin().archiveBot(req(ada), { botId: bot.id }));
    expect(notified).toEqual([]);
  });
});

// ─── Active version ──────────────────────────────────────────────────────────────────────────────

describe("rollback", () => {
  let ada: Author;
  let botId: string;
  let v1: string;
  let v2: string;

  beforeEach(async () => {
    ada = await signUp("ada");
    botId = (await createBot(ada, "a")).id;
    v1 = await addVersion(botId, 1, "archived", { rating: { mean: 90, ci: 5 } });
    v2 = await addVersion(botId, 2, "ready", { rating: { mean: 40, ci: 4 } });
  });

  it("switches the active version and starts the rating over", async () => {
    const result = ok(await admin().activateVersion(req(ada), { versionId: v1 }));
    expect(result.change).toMatchObject({
      reason: "activate",
      versionId: v1,
      previousVersionId: v2,
      changedAt: clock.getTime(),
    });
    expect(notified).toEqual([result.change]);
    expect(await statuses(botId)).toEqual({ 1: "ready", 2: "archived" });

    const rows = await d1.db
      .prepare("SELECT version_id, mean FROM ratings ORDER BY version_id")
      .all<{ version_id: string; mean: number }>();
    // The lucky frozen 90 is gone; v2 keeps its own (frozen) rating.
    expect(rows.results).toEqual([{ version_id: v2, mean: 40 }]);
    const activated = await d1.db
      .prepare("SELECT activated_at, updated_at FROM versions WHERE id = ?")
      .bind(v1)
      .first();
    expect(activated).toEqual({ activated_at: clock.getTime(), updated_at: clock.getTime() });

    const bot = await managed(ada, botId);
    expect(bot.activeVersion).toEqual({ id: v1, n: 1 });
    expect(bot.versions.find((v) => v.n === 1)).toMatchObject({ rating: null, canActivate: false });
    expect(bot.versions.find((v) => v.n === 2)).toMatchObject({ canActivate: true });
  });

  it("uses one of the day's deploys", async () => {
    expect((await overview(ada)).quota.deploysToday).toBe(0);
    const { quota } = ok(await admin().activateVersion(req(ada), { versionId: v1 }));
    expect(quota).toMatchObject({ deploysToday: 1, deploysPerDay: 20 });
    expect((await overview(ada)).quota.deploysToday).toBe(1);

    // Tomorrow it no longer counts.
    clock = new Date("2026-10-27T00:00:01Z");
    expect((await overview(ada)).quota).toMatchObject({
      deploysToday: 0,
      resetsAt: "2026-10-28T00:00:00.000Z",
    });
  });

  it("stops at the daily quota without changing anything", async () => {
    const limited = admin({ deploysPerDay: 1 });
    ok(await limited.activateVersion(req(ada), { versionId: v1 }));
    expectError(await limited.activateVersion(req(ada), { versionId: v2 }), "quota_exceeded");
    expect(await statuses(botId)).toEqual({ 1: "ready", 2: "archived" });
    expect(notified).toHaveLength(1);
  });

  it("only takes versions that were active before", async () => {
    const checking = await addVersion(botId, 3, "validating");
    const rejected = await addVersion(botId, 4, "rejected");
    expectError(await admin().activateVersion(req(ada), { versionId: v2 }), "already_active");
    expectError(
      await admin().activateVersion(req(ada), { versionId: checking }),
      "version_not_activatable",
    );
    expectError(
      await admin().activateVersion(req(ada), { versionId: rejected }),
      "version_not_activatable",
    );
    expect(await statuses(botId)).toEqual({
      1: "archived",
      2: "ready",
      3: "validating",
      4: "rejected",
    });
    expect((await overview(ada)).quota.deploysToday).toBe(0);
  });

  it("keeps exactly one active version when rollbacks race", async () => {
    const candidates = [v1];
    for (let n = 3; n <= 8; n++) candidates.push(await addVersion(botId, n, "archived"));
    const results = await Promise.all([
      ...candidates.map((versionId) => admin().activateVersion(req(ada), { versionId })),
      admin().archiveVersion(req(ada), { versionId: v2 }),
    ]);
    // Every call ran as a whole, one after another; each saw the state the previous one left.
    const { results: log } = await d1.db
      .prepare(
        "SELECT kind, version_id, previous_version_id FROM activations WHERE bot_id = ? ORDER BY rowid",
      )
      .bind(botId)
      .all<{ kind: string; version_id: string | null; previous_version_id: string | null }>();
    expect(log).toHaveLength(results.filter((r) => r.ok).length);
    expect(log.filter((row) => row.kind === "activate")).toHaveLength(candidates.length);
    let current: string | null = v2;
    for (const row of log) {
      expect(row.previous_version_id).toBe(current);
      current = row.version_id;
    }
    const ready = await readyVersions(botId);
    expect(ready).toEqual(current ? [current] : []);
    expect(ready.length).toBeLessThanOrEqual(1);
  });

  it("lets only as many racing rollbacks through as the quota allows", async () => {
    const candidates = [v1];
    for (let n = 3; n <= 6; n++) candidates.push(await addVersion(botId, n, "archived"));
    const limited = admin({ deploysPerDay: 2 });
    const results = await Promise.all(
      candidates.map((versionId) => limited.activateVersion(req(ada), { versionId })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    for (const r of results.filter((r) => !r.ok)) expectError(r, "quota_exceeded");
    expect(await readyVersions(botId)).toHaveLength(1);
  });
});

describe("archiving the active version", () => {
  it("leaves the bot without one, for free", async () => {
    const ada = await signUp("ada");
    const bot = await createBot(ada, "a");
    const v1 = await addVersion(bot.id, 1, "ready");
    const { change } = ok(await admin().archiveVersion(req(ada), { versionId: v1 }));
    expect(change).toMatchObject({ reason: "deactivate", versionId: null, previousVersionId: v1 });
    expect(notified).toEqual([change]);
    expect(await readyVersions(bot.id)).toEqual([]);
    expect((await overview(ada)).quota.deploysToday).toBe(0);
    expectError(await admin().archiveVersion(req(ada), { versionId: v1 }), "not_active");
  });
});

// ─── Overview ────────────────────────────────────────────────────────────────────────────────────

describe("overview", () => {
  it("shows quotas, lives today and rejected versions' reports", async () => {
    const ada = await signUp("ada");
    const bot = await createBot(ada, "a");
    const v1 = await addVersion(bot.id, 1, "rejected", {
      report: {
        ok: false,
        checks: [
          { name: "loads", ok: true },
          { name: "seeds", ok: false, message: "seed 3: exceeded the op budget at tick 412" },
        ],
      },
    });
    const v2 = await addVersion(bot.id, 2, "ready");
    const today = clock.getTime() - 3_600_000;
    const yesterday = clock.getTime() - 20 * 3_600_000;
    const life = d1.db.prepare(
      "INSERT INTO lives (id, version_id, room, start_tick, started_at, ended_at) VALUES (?, ?, 'r', 0, ?, ?)",
    );
    await d1.db.batch([
      life.bind("l1", v2, today, null),
      life.bind("l2", v2, today, today + 1000),
      life.bind("l3", v2, yesterday, today),
      life.bind("l4", v1, yesterday, yesterday + 1000),
    ]);

    const page = await overview(ada);
    expect(page).toMatchObject({
      username: "ada",
      activeBots: 1,
      limits: { botsPerAuthor: 3, deploysPerDay: 20, livesPerBotPerDay: 100 },
      quota: { deploysToday: 0, deploysPerDay: 20, resetsAt: "2026-10-27T00:00:00.000Z" },
    });
    expect(page.bots[0]).toMatchObject({ livesToday: 2, versionCount: 2 });
    expect(page.rejected).toEqual([
      {
        botId: bot.id,
        botName: "a",
        botSlug: "a",
        versionId: v1,
        n: 1,
        createdAt: expect.any(String),
        problems: ["Fixed seeds: seed 3: exceeded the op budget at tick 412"],
      },
    ]);
  });
});

// ─── Matchmaker ──────────────────────────────────────────────────────────────────────────────────

describe("matchmakerNotifier", () => {
  const change: ActiveVersionChange = {
    v: 1,
    botId: "b",
    ownerId: "o",
    reason: "activate",
    versionId: "v1",
    previousVersionId: "v2",
    changedAt: 1,
  };

  function namespace(stub: object) {
    return {
      idFromName: (name: string) => ({ name }),
      get: () => stub,
    } as unknown as DurableObjectNamespace;
  }

  it("calls activeVersionChanged on the global matchmaker", async () => {
    const calls: unknown[] = [];
    const ns = namespace({ activeVersionChanged: async (c: unknown) => calls.push(c) });
    await matchmakerNotifier(ns)(change);
    expect(calls).toEqual([change]);
  });

  it("never throws: no binding, a matchmaker without the method, or one that fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await matchmakerNotifier(undefined)(change);
    await matchmakerNotifier(namespace({}))(change);
    await matchmakerNotifier(
      namespace({
        activeVersionChanged: async () => {
          throw new Error("down");
        },
      }),
    )(change);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
