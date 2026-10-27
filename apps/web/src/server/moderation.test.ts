import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../db";
import { getLeaderboard, getProfile } from "../db/queries";
import type { ActiveVersionChange, ArenaControl, CheckReport } from "../shared";
import { signUp, type TestAccount } from "../test/accounts";
import { createTestPlatform, type TestPlatformEnv } from "../test/d1";
import { type Auth, createAuth } from "./auth";
import { createBotAdmin } from "./bot-admin";
import { createCliApi } from "./cli-api";
import { hashToken } from "./cli-auth";
import { createModeration, type ModerationResult, parseTarget } from "./moderation";

const BASE = "http://localhost:3000";

let platform: Awaited<ReturnType<typeof createTestPlatform>>;
let env: TestPlatformEnv;
let auth: Auth;
let notified: ActiveVersionChange[];
let controls: ArenaControl[];
let githubIds = 100;
let adminEnv: { ADMIN_USER_IDS?: string; ADMIN_GITHUB_IDS?: string };

let root: TestAccount;
let ada: TestAccount;

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  platform = await createTestPlatform();
  env = platform.env;
  auth = createAuth({
    DB: env.DB,
    BETTER_AUTH_URL: BASE,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    GITHUB_CLIENT_ID: "test-client-id",
    GITHUB_CLIENT_SECRET: "test-client-secret",
  });
  notified = [];
  controls = [];
  root = await signUp(auth, env.DB, BASE, "mod", ++githubIds);
  ada = await signUp(auth, env.DB, BASE, "ada", ++githubIds);
  adminEnv = { ADMIN_USER_IDS: root.id };
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await platform.dispose();
});

function moderation() {
  return createModeration(
    { DB: env.DB, BETTER_AUTH_URL: BASE, ...adminEnv },
    {
      getSession: (input) => auth.api.getSession(input),
      notify: async (change) => {
        notified.push(change);
      },
      notifyControl: async (control) => {
        controls.push(control);
      },
    },
  );
}

function botAdmin() {
  return createBotAdmin(
    { DB: env.DB, BETTER_AUTH_URL: BASE },
    { getSession: (input) => auth.api.getSession(input) },
  );
}

/** A server-function call: a POST with the session cookie and the site's `Origin`. */
function req(
  who: TestAccount | null,
  { origin = BASE, bearer }: { origin?: string | null; bearer?: string } = {},
) {
  const headers = new Headers();
  if (who) headers.set("cookie", who.jar.header());
  if (origin) headers.set("origin", origin);
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  return new Request(`${BASE}/_serverFn/admin`, { method: "POST", headers });
}

function ok<T>(result: ModerationResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}: ${result.message}`);
  return result.value;
}

function expectError(result: ModerationResult<unknown>, error: string) {
  expect(result).toMatchObject({ ok: false, error, message: expect.any(String) });
}

async function cliToken(account: TestAccount) {
  const token = `zsk_${crypto.randomUUID()}`;
  await env.DB.prepare(
    "INSERT INTO cli_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), account.id, await hashToken(token), Date.now() + 86_400_000)
    .run();
  return token;
}

async function deploy(token: string, slug = "snake", idempotencyKey?: string) {
  const response = await createCliApi(env).deploy(
    new Request(`${BASE}/api/bots/${slug}/versions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: JSON.stringify({
        bundle: `export default { tick() { return { turn: 0 }; } }; // ${idempotencyKey ?? crypto.randomUUID()}`,
        sources: [{ path: "src/bot.ts", content: "// bot" }],
      }),
    }),
    slug,
  );
  return { status: response.status, headers: response.headers, body: await response.json() };
}

/** A bot of `owner` with a `ready` version (40 rated lives: on the leaderboard) and one in checks. */
async function botWithVersions(owner: TestAccount, slug = "snake") {
  const botId = `${owner.login}-${slug}`;
  const report: CheckReport = { ok: true, checks: [{ name: "limits", ok: true }] };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO bots (id, owner_id, name, slug) VALUES (?, ?, ?, ?)").bind(
      botId,
      owner.id,
      slug,
      slug,
    ),
    env.DB.prepare(
      `INSERT INTO versions (id, bot_id, n, status, bundle_key, source_key, report, enqueued_at)
       VALUES (?, ?, 1, 'ready', 'b.js', 's.json', ?, 1)`,
    ).bind(`${botId}-v1`, botId, JSON.stringify(report)),
    env.DB.prepare(
      `INSERT INTO versions (id, bot_id, n, status, bundle_key, source_key, enqueued_at)
       VALUES (?, ?, 2, 'validating', 'b.js', 's.json', 1)`,
    ).bind(`${botId}-v2`, botId),
    env.DB.prepare(
      "INSERT INTO ratings (version_id, mean, ci, n_lives) VALUES (?, 10, 1, 40)",
    ).bind(`${botId}-v1`),
  ]);
  return { botId, ready: `${botId}-v1`, validating: `${botId}-v2` };
}

async function version(id: string) {
  const row = await env.DB.prepare("SELECT status, report, change_seq FROM versions WHERE id = ?")
    .bind(id)
    .first<{ status: string; report: string | null; change_seq: number }>();
  if (!row) throw new Error(`no version ${id}`);
  return { ...row, report: row.report ? (JSON.parse(row.report) as CheckReport) : null };
}

const leaderboardBots = async () =>
  (await getLeaderboard(createDb(env.DB))).map((entry) => entry.botId);

// ─── Authorization ───────────────────────────────────────────────────────────────────────────────

describe("authorization", () => {
  const calls = {
    overview: (m: ReturnType<typeof moderation>, r: Request) => m.overview(r),
    setArenaPaused: (m: ReturnType<typeof moderation>, r: Request) =>
      m.setArenaPaused(r, { paused: true, reason: "test" }),
    setDeploysPaused: (m: ReturnType<typeof moderation>, r: Request) =>
      m.setDeploysPaused(r, { paused: true, reason: "test" }),
    banUser: (m: ReturnType<typeof moderation>, r: Request) =>
      m.banUser(r, { user: "@ada", reason: "test" }),
    unbanUser: (m: ReturnType<typeof moderation>, r: Request) =>
      m.unbanUser(r, { user: "@ada", reason: "test" }),
    banBot: (m: ReturnType<typeof moderation>, r: Request) =>
      m.banBot(r, { bot: "@ada/snake", reason: "test" }),
    unbanBot: (m: ReturnType<typeof moderation>, r: Request) =>
      m.unbanBot(r, { bot: "@ada/snake", reason: "test" }),
    banVersion: (m: ReturnType<typeof moderation>, r: Request) =>
      m.banVersion(r, { version: "@ada/snake/1", reason: "test" }),
  };

  it.each(Object.entries(calls))(
    "%s: refuses non-admins, CLI tokens and no session",
    async (_, call) => {
      await botWithVersions(ada);
      const m = moderation();
      expectError(await call(m, req(ada)), "not_admin");
      expectError(await call(m, req(null)), "unauthorized");
      // A CLI token is never a session, the admin's own included.
      expectError(await call(m, req(null, { bearer: await cliToken(root) })), "unauthorized");
      expectError(await call(m, req(null, { bearer: await cliToken(ada) })), "unauthorized");
      // Nothing changed.
      expect((await version("ada-snake-v1")).status).toBe("ready");
      const control = await env.DB.prepare(
        "SELECT paused, deploys_paused FROM arena_control",
      ).first();
      expect(control).toEqual({ paused: 0, deploys_paused: 0 });
    },
  );

  it("refuses changes from another origin, even an admin's", async () => {
    await botWithVersions(ada);
    const m = moderation();
    const evil = { origin: "https://evil.example" };
    expectError(
      await m.banUser(req(root, evil), { user: "@ada", reason: "csrf" }),
      "forbidden_origin",
    );
    expectError(
      await m.setArenaPaused(req(root, { origin: null }), { paused: true, reason: "csrf" }),
      "forbidden_origin",
    );
    expect((await version("ada-snake-v1")).status).toBe("ready");
    // Reads don't need the origin.
    ok(await m.overview(req(root, { origin: null })));
  });

  it("takes admins by user id or numeric GitHub id, never by login", async () => {
    adminEnv = { ADMIN_GITHUB_IDS: ` 1, ${ada.githubId} ,` };
    expect(ok(await moderation().overview(req(ada))).admin).toEqual({
      id: ada.id,
      username: "ada",
    });
    expectError(await moderation().overview(req(root)), "not_admin");
    adminEnv = { ADMIN_GITHUB_IDS: "ada,root", ADMIN_USER_IDS: "" };
    expectError(await moderation().overview(req(ada)), "not_admin");
    expect(await moderation().isAdmin(ada.id)).toBe(false);
  });

  it("can't ban an admin", async () => {
    adminEnv = { ADMIN_USER_IDS: `${root.id},${ada.id}` };
    expectError(
      await moderation().banUser(req(root), { user: "@ada", reason: "oops" }),
      "cannot_ban_admin",
    );
    expectError(
      await moderation().banUser(req(root), { user: "@mod", reason: "oops" }),
      "cannot_ban_admin",
    );
  });

  it("wants a reason", async () => {
    expectError(
      await moderation().banUser(req(root), { user: "@ada", reason: " x " }),
      "invalid_request",
    );
  });
});

// ─── Kill switch ─────────────────────────────────────────────────────────────────────────────────

/** The query `src/shared/arena.ts` tells the matchmaker and rooms to run. */
const CONTRACT_SQL =
  "SELECT paused, deploys_paused, reason, deploys_reason, updated_at FROM arena_control WHERE id = 1";

describe("kill switch", () => {
  it("starts running, pauses and resumes the arena through the documented row", async () => {
    expect(await env.DB.prepare(CONTRACT_SQL).first()).toMatchObject({
      paused: 0,
      deploys_paused: 0,
    });
    const m = moderation();
    const paused = ok(await m.setArenaPaused(req(root), { paused: true, reason: "runaway bot" }));
    expect(paused).toMatchObject({ paused: true, deploysPaused: false, updatedBy: "mod" });
    expect(await env.DB.prepare(CONTRACT_SQL).first()).toMatchObject({
      paused: 1,
      deploys_paused: 0,
      reason: "runaway bot",
    });
    expect(controls).toEqual([
      {
        v: 1,
        paused: true,
        deploysPaused: false,
        reason: "runaway bot",
        deploysReason: null,
        updatedAt: expect.any(Number),
      },
    ]);
    expectError(await m.setArenaPaused(req(root), { paused: true, reason: "again" }), "no_change");
    expect(controls).toHaveLength(1);

    ok(await m.setArenaPaused(req(root), { paused: false, reason: "fixed" }));
    expect(await env.DB.prepare(CONTRACT_SQL).first()).toMatchObject({
      paused: 0,
      reason: "fixed",
    });
    const page = ok(await m.overview(req(root)));
    expect(page.recent.map((r) => [r.action, r.admin, r.reason])).toEqual([
      ["resume_arena", "mod", "fixed"],
      ["pause_arena", "mod", "runaway bot"],
    ]);
  });

  it("recreates the row if it's missing", async () => {
    await env.DB.prepare("DELETE FROM arena_control").run();
    ok(await moderation().setArenaPaused(req(root), { paused: true, reason: "no row" }));
    expect(await env.DB.prepare(CONTRACT_SQL).first()).toMatchObject({ paused: 1 });
  });

  it("refuses deploys with 503 deploys_paused while they're paused", async () => {
    await env.DB.prepare(
      "INSERT INTO bots (id, owner_id, name, slug) VALUES ('b', ?, 'S', 'snake')",
    )
      .bind(ada.id)
      .run();
    const token = await cliToken(ada);
    ok(await moderation().setDeploysPaused(req(root), { paused: true, reason: "maintenance" }));
    const refused = await deploy(token);
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("300");
    expect(refused.body).toMatchObject({
      error: "deploys_paused",
      message: expect.stringContaining("maintenance"),
    });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM versions").first()).toEqual({ n: 0 });

    ok(await moderation().setDeploysPaused(req(root), { paused: false, reason: "done" }));
    expect((await deploy(token)).status).toBe(201);
  });

  it("still answers a retry of a deploy made before the pause with its version", async () => {
    await env.DB.prepare(
      "INSERT INTO bots (id, owner_id, name, slug) VALUES ('b', ?, 'S', 'snake')",
    )
      .bind(ada.id)
      .run();
    const token = await cliToken(ada);
    const first = await deploy(token, "snake", "before-the-pause");
    expect(first.status).toBe(201);
    ok(await moderation().setDeploysPaused(req(root), { paused: true, reason: "maintenance" }));
    const retry = await deploy(token, "snake", "before-the-pause");
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ version: { n: 1 } });
    expect((await deploy(token, "snake", "after-the-pause")).status).toBe(503);
  });

  it("keeps a reason per switch, so changing one never rewrites the other's", async () => {
    await env.DB.prepare(
      "INSERT INTO bots (id, owner_id, name, slug) VALUES ('b', ?, 'S', 'snake')",
    )
      .bind(ada.id)
      .run();
    const token = await cliToken(ada);
    const m = moderation();
    ok(await m.setDeploysPaused(req(root), { paused: true, reason: "maintenance" }));
    ok(await m.setArenaPaused(req(root), { paused: true, reason: "runaway bot" }));
    const view = ok(await m.setArenaPaused(req(root), { paused: false, reason: "fixed" }));
    expect(view).toMatchObject({
      paused: false,
      deploysPaused: true,
      reason: "fixed",
      deploysReason: "maintenance",
    });
    expect(await env.DB.prepare(CONTRACT_SQL).first()).toMatchObject({
      reason: "fixed",
      deploys_reason: "maintenance",
    });
    expect(controls.at(-1)).toMatchObject({ reason: "fixed", deploysReason: "maintenance" });
    const refused = await deploy(token);
    expect(refused.body).toMatchObject({ error: "deploys_paused" });
    expect((refused.body as { message: string }).message).toContain("(maintenance)");
    expect((refused.body as { message: string }).message).not.toContain("fixed");
  });
});

// ─── Bans ────────────────────────────────────────────────────────────────────────────────────────

describe("banning a user", () => {
  it("stops their bots, blocks deploys and changes, hides them, and can be lifted", async () => {
    const bot = await botWithVersions(ada);
    const before = await version(bot.ready);
    const token = await cliToken(ada);
    expect(await leaderboardBots()).toEqual([bot.botId]);

    const result = ok(await moderation().banUser(req(root), { user: "@ada", reason: "cheating" }));
    expect(result).toEqual({ stoppedVersions: 1 });

    const ready = await version(bot.ready);
    expect(ready.status).toBe("archived");
    expect(ready.change_seq).toBeGreaterThan(before.change_seq);
    const validating = await version(bot.validating);
    expect(validating.status).toBe("rejected");
    expect(validating.report?.checks).toEqual([
      { name: "moderation", ok: false, message: expect.stringContaining("suspended") },
    ]);
    expect(notified).toEqual([
      {
        v: 1,
        botId: bot.botId,
        ownerId: ada.id,
        reason: "moderation",
        versionId: null,
        previousVersionId: bot.ready,
        changedAt: expect.any(Number),
      },
    ]);

    // Can't deploy, can't change bots on the site, can't make a version ready by any route.
    const refused = await deploy(token);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      error: "user_banned",
      message: expect.stringContaining("cheating"),
    });
    expect(await botAdmin().createBot(req(ada), { name: "Other" })).toMatchObject({
      ok: false,
      error: "user_banned",
    });
    expect(await botAdmin().activateVersion(req(ada), { versionId: bot.ready })).toMatchObject({
      ok: false,
      error: "user_banned",
    });
    await expect(
      env.DB.prepare("UPDATE versions SET status = 'ready' WHERE id = ?").bind(bot.ready).run(),
    ).rejects.toThrow(/bot is banned/);
    // The site still shows them their page, with the ban.
    const page = await botAdmin().overview(req(ada));
    expect(page).toMatchObject({ ok: true, value: { banned: { reason: "cheating" } } });
    expect(await leaderboardBots()).toEqual([]);
    expect(await getProfile(createDb(env.DB), "ada")).toBeNull();
    expectError(
      await moderation().banUser(req(root), { user: "ada", reason: "twice" }),
      "already_banned",
    );
    expect(ok(await moderation().overview(req(root))).bannedUsers).toMatchObject([
      { id: ada.id, username: "ada", reason: "cheating" },
    ]);

    ok(await moderation().unbanUser(req(root), { user: ada.id, reason: "appeal" }));
    expect((await deploy(token)).status).toBe(201);
    expect(await getProfile(createDb(env.DB), "ada")).not.toBeNull();
  });
});

describe("banning a bot", () => {
  it("stops it and blocks deploys, rollbacks and restores until lifted", async () => {
    const bot = await botWithVersions(ada);
    const other = await botWithVersions(ada, "other");
    const token = await cliToken(ada);

    ok(await moderation().banBot(req(root), { bot: `${BASE}/@ada/snake`, reason: "exploit" }));
    expect((await version(bot.ready)).status).toBe("archived");
    expect((await version(bot.validating)).status).toBe("rejected");
    expect((await version(other.ready)).status).toBe("ready");
    expect(notified.map((n) => [n.botId, n.reason, n.previousVersionId])).toEqual([
      [bot.botId, "moderation", bot.ready],
    ]);

    const refused = await deploy(token);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: "bot_banned", bot: { slug: "snake" } });
    expect((await deploy(token, "other")).status).toBe(201);
    expect(await botAdmin().activateVersion(req(ada), { versionId: bot.ready })).toMatchObject({
      ok: false,
      error: "bot_banned",
    });
    await env.DB.prepare("UPDATE bots SET archived_at = 1 WHERE id = ?").bind(bot.botId).run();
    expect(await botAdmin().restoreBot(req(ada), { botId: bot.botId })).toMatchObject({
      ok: false,
      error: "bot_banned",
    });
    await env.DB.prepare("UPDATE bots SET archived_at = NULL WHERE id = ?").bind(bot.botId).run();
    expect(await leaderboardBots()).toEqual([other.botId]);

    ok(await moderation().unbanBot(req(root), { bot: "ada/snake", reason: "fixed" }));
    expect(await botAdmin().activateVersion(req(ada), { versionId: bot.ready })).toMatchObject({
      ok: true,
    });
  });
});

describe("banning a version", () => {
  it("rejects it with a moderation check after the earlier ones, off the leaderboard", async () => {
    const bot = await botWithVersions(ada);
    const before = await version(bot.ready);

    const result = ok(
      await moderation().banVersion(req(root), {
        version: `${BASE}/@ada/snake?v=1`,
        reason: "reads other bots' memory",
      }),
    );
    expect(result).toEqual({ stoppedVersions: 1 });
    const after = await version(bot.ready);
    expect(after.status).toBe("rejected");
    expect(after.change_seq).toBeGreaterThan(before.change_seq);
    expect(after.report).toEqual({
      ok: false,
      checks: [
        { name: "limits", ok: true },
        { name: "moderation", ok: false, message: "reads other bots' memory" },
      ],
    });
    expect(notified).toMatchObject([{ reason: "moderation", previousVersionId: bot.ready }]);
    expect(await leaderboardBots()).toEqual([]);

    // The matchmaker's incremental poll sees it.
    const { results } = await env.DB.prepare(
      "SELECT id, status FROM versions WHERE change_seq > ? ORDER BY change_seq LIMIT 500",
    )
      .bind(before.change_seq)
      .all();
    expect(results).toContainEqual({ id: bot.ready, status: "rejected" });

    // A report from the checks consumer: its `text` (what the CLI prints) leads with the ban.
    const suiteText = "Checks passed: this bot can be deployed.\n\n✓ Limits  fine\n";
    await env.DB.prepare(
      `INSERT INTO versions (id, bot_id, n, status, bundle_key, source_key, report, enqueued_at)
       VALUES ('v3', ?, 3, 'archived', 'b.js', 's.json', ?, 1)`,
    )
      .bind(bot.botId, JSON.stringify({ ok: true, checks: [], text: suiteText }))
      .run();
    ok(await moderation().banVersion(req(root), { version: "@ada/snake/3", reason: "copied" }));
    expect((await version("v3")).report).toEqual({
      ok: false,
      checks: [{ name: "moderation", ok: false, message: "copied" }],
      text: `Rejected by a moderator: copied\n\n${suiteText}`,
    });

    // The bot itself isn't banned: the version in checks is untouched.
    expect((await version(bot.validating)).status).toBe("validating");
    ok(await moderation().banVersion(req(root), { version: bot.validating, reason: "same" }));
    expect((await version(bot.validating)).report?.checks).toEqual([
      { name: "moderation", ok: false, message: "same" },
    ]);
    expectError(
      await moderation().banVersion(req(root), { version: "@ada/snake/1", reason: "again" }),
      "already_banned",
    );
    expectError(
      await moderation().banVersion(req(root), { version: "@ada/snake/9", reason: "missing" }),
      "version_not_found",
    );
  });
});

describe("the checks consumer's contract (CheckJob)", () => {
  it("aborts the documented markPassed batch with `bot is banned`, changing nothing", async () => {
    const bot = await botWithVersions(ada);
    // A ban landing between the consumer's read and its write: the `validating` version is
    // still there (a real ban rejects it in the same batch).
    await env.DB.prepare("UPDATE bots SET banned_at = 1 WHERE id = ?").bind(bot.botId).run();
    const markPassed = env.DB.batch([
      env.DB.prepare(
        `UPDATE versions SET status = 'archived', updated_at = ?3
         WHERE bot_id = ?2 AND status = 'ready'
           AND EXISTS (SELECT 1 FROM versions WHERE id = ?1 AND status = 'validating')
           AND (SELECT archived_at FROM bots WHERE id = ?2) IS NULL`,
      ).bind(bot.validating, bot.botId, 5),
      env.DB.prepare(
        `UPDATE versions SET status = 'ready', activated_at = ?3, updated_at = ?3
         WHERE id = ?1 AND status = 'validating'
           AND (SELECT archived_at FROM bots WHERE id = ?2) IS NULL
         RETURNING id`,
      ).bind(bot.validating, bot.botId, 5),
    ]);
    await expect(markPassed).rejects.toThrow(/bot is banned/);
    expect((await version(bot.ready)).status).toBe("ready");
    expect((await version(bot.validating)).status).toBe("validating");
    // What the contract says to do instead: reject it.
    await env.DB.prepare(
      "UPDATE versions SET status = 'rejected' WHERE id = ? AND status = 'validating'",
    )
      .bind(bot.validating)
      .run();
    expect((await version(bot.validating)).status).toBe("rejected");
  });
});

describe("parseTarget", () => {
  it.each([
    ["@ada", ["ada"], null],
    ["ada", ["ada"], null],
    ["@ada/snake", ["ada", "snake"], null],
    ["/@ada/snake/", ["ada", "snake"], null],
    ["@ada/snake/3", ["ada", "snake"], 3],
    ["@ada/snake/v3", ["ada", "snake"], 3],
    ["@ada/snake?v=3", ["ada", "snake"], 3],
    ["https://arena.example/@ada/snake?v=12", ["ada", "snake"], 12],
    ["https://arena.example/%40ada/snake", ["ada", "snake"], null],
    ["0b5f6a3e-1c1e-4d2a-9a43-6f0a1d6c8e11", ["0b5f6a3e-1c1e-4d2a-9a43-6f0a1d6c8e11"], null],
  ])("%s", (ref, parts, n) => {
    expect(parseTarget(ref)).toEqual({ parts, n });
  });
});
