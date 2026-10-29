/**
 * `login`, `logout`, `deploy`, `status` and `logs` against {@link FakeArena}, an in-memory stand-in
 * for the site's API. `remote.integration.test.ts` runs the same flow against the real one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatReport, runChecks } from "@zerosnake/checks";
import { DEFAULT_CONFIG, rulesId } from "@zerosnake/engine";
import {
  type DeployRequest,
  printable,
  type TraceResponse,
  type TraceTick,
  type CheckReport as WebCheckReport,
} from "@zerosnake/web/shared";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "./cli.ts";
import { DEFAULT_CONTEXT } from "./commands/logs.ts";
import { Credentials } from "./remote/config.ts";
import { apiError, FakeArena, htmlNotFound, SERVER } from "./testing/fake-arena.ts";
import {
  captureIo,
  cleanUp,
  GOOD_BOT,
  makeProject,
  PASSING_BOT,
  SUICIDAL_BOT,
  TUNING,
} from "./testing/project.ts";

afterAll(cleanUp);

function botProject(files: Record<string, string> = {}): string {
  return makeProject({
    "package.json": JSON.stringify({ name: "my-snake" }),
    "src/bot.ts": GOOD_BOT,
    "src/tuning.ts": TUNING,
    ...files,
  });
}

/** A fake arena, a config folder, and (unless `loggedIn: false`) a stored token it accepts. */
function setUp({ loggedIn = true } = {}) {
  const arena = new FakeArena();
  const configDir = makeProject({});
  const opened: string[] = [];
  const slept: number[] = [];
  const remote = arena.remote({ ZEROSNAKE_CONFIG_DIR: configDir }, opened);
  const sleep = remote.sleep;
  remote.sleep = (ms) => {
    slept.push(ms);
    return sleep(ms);
  };
  const store = new Credentials(configDir);
  if (loggedIn) {
    arena.tokens.add("zsk_stored");
    store.set(SERVER, { token: "zsk_stored", username: "ada", savedAt: "2026-10-27T00:00:00Z" });
  }
  const run = async (argv: string[], cwd = botProject()) => {
    const io = captureIo(cwd);
    const code = await main(argv, io, remote);
    return { code, out: io.stdout(), err: io.stderr(), all: `${io.stdout()}\n${io.stderr()}` };
  };
  return { arena, remote, store, opened, slept, run, configDir };
}

describe("zerosnake login", () => {
  it("runs the device flow, stores the token privately and never prints it", async () => {
    const { arena, store, opened, slept, run, configDir } = setUp({ loggedIn: false });
    const r = await run(["login"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`open ${SERVER}/device and enter the code`);
    expect(r.out).toContain("WXYZ-1234");
    expect(r.out).toContain(`Logged in to ${SERVER} as @ada.`);
    expect(opened).toEqual([`${SERVER}/device?user_code=WXYZ-1234`]);
    expect(slept).toEqual([5000, 5000]);
    expect(store.get(SERVER)).toMatchObject({ token: "zsk_secret1", username: "ada" });
    expect(r.all).not.toContain("zsk_");
    expect(readFileSync(join(configDir, "credentials.json"), "utf8")).toContain("zsk_secret1");
    expect(arena.calls("POST", /cli\/token/)[0]?.body).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "device-123",
      client_id: "zerosnake-cli",
    });
  });

  it("slows down when asked and rides out connection trouble", async () => {
    const { arena, slept, run } = setUp({ loggedIn: false });
    arena.devicePolls = ["authorization_pending", "slow_down", "authorization_pending"];
    arena.fail("POST", /cli\/token/, "network");
    arena.fail("POST", /cli\/token/, new Response("bad gateway", { status: 502 }));
    const r = await run(["login", "--no-open"]);
    expect(r.code, r.err).toBe(0);
    expect(slept).toEqual([5000, 5000, 5000, 5000, 10_000, 10_000]);
  });

  it("stops when the login is denied or the code expires", async () => {
    const denied = setUp({ loggedIn: false });
    denied.arena.devicePolls = ["access_denied"];
    const r = await denied.run(["login", "--no-open"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("The login was denied in the browser");
    expect(denied.store.get(SERVER)).toBeNull();

    const expired = setUp({ loggedIn: false });
    expired.arena.devicePolls = Array(200).fill("authorization_pending");
    const e = await expired.run(["login", "--no-open"]);
    expect(e.code).toBe(1);
    expect(e.err).toContain("The code expired before it was approved");
  });

  it("stops at a redirect instead of polling on", async () => {
    const { arena, run } = setUp({ loggedIn: false });
    arena.fail(
      "POST",
      /cli\/token/,
      new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } }),
    );
    const r = await run(["login", "--no-open"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("redirected (HTTP 302 to https://elsewhere.test/)");
    expect(r.err).not.toContain("Couldn't reach");
    expect(arena.calls("POST", /cli\/token/)).toHaveLength(1);
  });

  it("revokes a new token when it can't finish the login", async () => {
    const { arena, store, run } = setUp();
    arena.fail("GET", /cli\/me$/, htmlNotFound());
    const r = await run(["login", "--no-open"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("The new login wasn't saved.");
    expect(r.all).not.toContain("zsk_");
    expect(arena.revoked).toEqual(["zsk_secret1"]);
    // The previous login is untouched and still works.
    expect(store.get(SERVER)?.token).toBe("zsk_stored");
    expect(arena.tokens.has("zsk_stored")).toBe(true);

    // A dropped connection is retried; one that stays down leaves a token to remove by hand.
    const flaky = setUp({ loggedIn: false });
    flaky.arena.fail("GET", /cli\/me$/, "network");
    expect((await flaky.run(["login", "--no-open"])).code).toBe(0);
    expect(flaky.store.get(SERVER)?.token).toBe("zsk_secret1");

    const down = setUp({ loggedIn: false });
    for (let i = 0; i < 10; i++) down.arena.fail("GET", /cli\/me$/, "network");
    down.arena.fail("POST", /cli\/logout$/, "network");
    const d = await down.run(["login", "--no-open"]);
    expect(d.code).toBe(1);
    expect(d.err).toContain(`couldn't be revoked: remove it at ${SERVER}/settings`);
    expect(d.all).not.toContain("zsk_");
    expect(down.store.get(SERVER)).toBeNull();
  });

  it("revokes the token a new login replaces", async () => {
    const { arena, store, run } = setUp();
    expect((await run(["login", "--no-open"])).code).toBe(0);
    expect(arena.revoked).toEqual(["zsk_stored"]);
    expect(store.get(SERVER)?.token).toBe("zsk_secret1");
  });
});

describe("zerosnake logout", () => {
  it("revokes the token and deletes it", async () => {
    const { arena, store, run } = setUp();
    const r = await run(["logout"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Logged out of ${SERVER}`);
    expect(arena.revoked).toEqual(["zsk_stored"]);
    expect(store.get(SERVER)).toBeNull();
    expect((await run(["logout"])).out).toContain("You aren't logged in");
  });

  it("deletes the token even when the server can't be reached", async () => {
    const { arena, store, run } = setUp();
    arena.fail("POST", /cli\/logout/, "network");
    const r = await run(["logout"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain(`revoke it at ${SERVER}/settings`);
    expect(store.get(SERVER)).toBeNull();
  });
});

describe("zerosnake deploy", () => {
  it("needs a login", async () => {
    const { run } = setUp({ loggedIn: false });
    const r = await run(["deploy"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      `You're not logged in to ${SERVER}. Run \`zerosnake login --url ${SERVER}\``,
    );
  });

  it("names your bots when the project's isn't one of them, and uploads nothing", async () => {
    const { arena, run } = setUp();
    arena.addBot("greedy");
    const r = await run(["deploy"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('No bot "my-snake". @ada has: greedy.');
    expect(r.err).toContain("--create");
    expect(arena.calls("POST", /versions/)).toHaveLength(0);
  });

  it("creates your first bot, uploads bundle and sources, and waits for the checks", async () => {
    const { arena, run } = setUp();
    const r = await run(["deploy", "-m", "first try"], botProject({ "src/bot.ts": PASSING_BOT }));
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("within the deploy limits");
    expect(r.out).toMatch(
      /✓ passes the checks \(mean score per life [\d.]+, easy in your seat [\d.]+\)/,
    );
    expect(r.out).toContain("created the bot my-snake");
    expect(r.out).toContain("uploaded my-snake v1 (19 of 20 deploys left today)");
    expect(r.out).toContain("my-snake v1 passed the checks and is live in the arena.");
    expect(r.out).toContain("qualification score 42.0");
    expect(r.out).toContain(`${SERVER}/@ada/my-snake?v=1`);
    expect(r.err).toContain("Waiting for the server to check my-snake v1");

    expect(arena.calls("POST", /^\/api\/bots$/)[0]?.body).toEqual({
      name: "my-snake",
      slug: "my-snake",
    });
    const [upload] = arena.calls("POST", /versions/);
    const body = upload?.body as DeployRequest;
    expect(body.bundle).toContain("export");
    expect(body.sources.map((s) => s.path)).toEqual(["src/bot.ts", "src/tuning.ts"]);
    expect(body.sources[0]?.content).toBe(PASSING_BOT);
    expect(body.meta).toMatchObject({
      cliVersion: expect.any(String),
      rules: rulesId(DEFAULT_CONFIG),
      message: "first try",
    });
    expect(upload?.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(arena.calls("GET", /versions\/1$/).length).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it("runs the server's checks first and uploads nothing when they fail", async () => {
    const { arena, run } = setUp();
    arena.addBot("my-snake");
    const cwd = botProject({ "src/bot.ts": SUICIDAL_BOT });
    const r = await run(["deploy"], cwd);
    expect(r.code).toBe(1);
    expect(r.out).toContain("within the deploy limits");
    expect(r.err).toContain("Checks failed: this bot would be rejected.");
    expect(r.err).toContain("✗ Qualifies");
    expect(r.err).toContain("Not uploaded: the server would reject this version.");
    expect(r.err).toContain("--skip-local-checks");
    expect(arena.calls("POST", /versions/)).toHaveLength(0);

    // The escape hatch: the server decides.
    const skipped = await run(["deploy", "--skip-local-checks", "--no-wait"], cwd);
    expect(skipped.code, skipped.err).toBe(0);
    expect(skipped.out).toContain("within the deploy limits");
    expect(skipped.out).toContain("skipped the check suite here (--skip-local-checks)");
    expect(skipped.all).not.toContain("Running the checks");
    expect(skipped.out).toContain("uploaded my-snake v1");
  }, 120_000);

  it("prints a rejection report from the check suite like `zerosnake test` does", async () => {
    const { arena, run } = setUp();
    arena.addBot("my-snake");
    const report = await runChecks(
      { bundle: "export default {}", sources: [{ path: "src/bot.ts", bytes: 17 }] },
      { seeds: [1], ticks: 10 },
    );
    arena.outcome = { status: "rejected", report: report as unknown as WebCheckReport, polls: 1 };
    const r = await run(["deploy", "--skip-local-checks"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("my-snake v1 was rejected:");
    expect(r.err).toContain("  Checks failed: this bot would be rejected.");
    expect(r.err).toContain("  ✗ Loads     the bundle does not load");
    const logs = await run(["logs", "--version", "1"]);
    expect(logs.out).toContain("✗ Loads     the bundle does not load");
  });

  it("prints the checks consumer's stored report (#65): its suite, else its text", async () => {
    const { arena, run } = setUp();
    arena.addBot("my-snake");
    const suite = await runChecks(
      { bundle: "export default {}", sources: [{ path: "src/bot.ts", bytes: 17 }] },
      { seeds: [1], ticks: 10 },
    );
    // `versionReport` in apps/arena/src/checks/report.ts: the site's lines, plus the suite's report.
    const stored = {
      ok: false,
      checks: [{ name: "loads", ok: false, message: "site line, not what `test` prints" }],
      suite,
      text: formatReport(suite),
    };
    arena.outcome = { status: "rejected", report: stored as WebCheckReport, polls: 1 };
    const r = await run(["deploy", "--skip-local-checks"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("  Checks failed: this bot would be rejected.");
    expect(r.err).toContain("  ✗ Loads     the bundle does not load");
    expect(r.err).not.toContain("site line");
    expect((await run(["logs", "--version", "1"])).out).toContain(
      "✗ Loads     the bundle does not load",
    );

    // A suite report this CLI doesn't know (a newer version): the server's text.
    arena.outcome = {
      status: "rejected",
      report: {
        ...stored,
        suite: { version: 999 },
        text: "Checks failed: from the server.\n",
      } as WebCheckReport,
      polls: 1,
    };
    const newer = await run(["deploy", "--skip-local-checks"]);
    expect(newer.err).toContain("  Checks failed: from the server.");
    expect(newer.err).not.toContain("site line");

    // `failureReport`: the consumer ended the version without a verdict from the suite.
    arena.outcome = {
      status: "rejected",
      report: {
        ok: false,
        checks: [{ name: "deploy", ok: false, message: "The checks didn't finish." }],
        reason: "checks_failed_to_complete",
      } as WebCheckReport,
      polls: 1,
    };
    const unfinished = await run(["deploy", "--skip-local-checks"]);
    expect(unfinished.err).toContain("✗ deploy: The checks didn't finish.");
  });

  it("puts checks added after the suite (a ban, the arena's backstop) above its report", async () => {
    const { arena, run } = setUp();
    arena.addBot("my-snake");
    const suite = await runChecks(
      { bundle: "export default {}", sources: [{ path: "src/bot.ts", bytes: 17 }] },
      { seeds: [1], ticks: 10 },
    );
    // A version the suite passed would read "Checks passed", so the verdict has to come first.
    const banned = {
      ok: false,
      checks: [
        { name: "loads", ok: true, message: "loads" },
        { name: "arena-backstop", ok: false, message: "It crashed its room 3 times." },
        { name: "moderation", ok: false, message: "reads other bots' memory" },
      ],
      suite,
      text: `Rejected by a moderator: reads other bots' memory\n\n${formatReport(suite)}`,
    };
    arena.outcome = { status: "rejected", report: banned as WebCheckReport, polls: 1 };
    const r = await run(["deploy", "--skip-local-checks"]);
    expect(r.code).toBe(1);
    const backstop = r.err.indexOf("✗ Arena: It crashed its room 3 times.");
    const ban = r.err.indexOf("✗ Moderation: reads other bots' memory");
    const suiteAt = r.err.indexOf("Checks failed: this bot would be rejected.");
    expect(backstop).toBeGreaterThan(-1);
    expect(ban).toBeGreaterThan(backstop);
    expect(suiteAt).toBeGreaterThan(ban);
    expect((await run(["logs", "--version", "1"])).out).toContain(
      "✗ Moderation: reads other bots' memory",
    );

    // Only the server's text (a suite this CLI doesn't know): the ban it carries isn't repeated.
    arena.outcome = {
      status: "rejected",
      report: { ...banned, suite: { version: 999 } } as WebCheckReport,
      polls: 1,
    };
    const textOnly = await run(["deploy", "--skip-local-checks"]);
    expect(textOnly.err).toContain("  Rejected by a moderator: reads other bots' memory");
    expect(textOnly.err).not.toContain("✗ Moderation");
    expect(textOnly.err).toContain("✗ Arena: It crashed its room 3 times.");
  });

  it("shows the server's note that the version was tested locally on other rules", async () => {
    const { arena, run } = setUp();
    arena.addBot("my-snake");
    const suite = await runChecks(
      { bundle: "export default {}", sources: [{ path: "src/bot.ts", bytes: 17 }] },
      { seeds: [1], ticks: 10 },
    );
    const note =
      "zerosnake 0.1.0 tested this version on other rules than the arena's (a turn rate of " +
      "0.25; the arena's is 0.4), so its `zerosnake test` can disagree with this verdict.";
    // As the checks consumer writes it (apps/arena `noteOtherRules`).
    const report = {
      ok: false,
      checks: [
        { name: "qualification", ok: false, message: "scores below easy" },
        { name: "rules", ok: false, message: note },
      ],
      suite,
      text: formatReport(suite),
    };
    arena.outcome = { status: "rejected", report: report as WebCheckReport, polls: 1 };
    const r = await run(["deploy", "--skip-local-checks"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`✗ Local rules: ${note}`);
    expect(r.err.indexOf("✗ Local rules")).toBeLessThan(r.err.indexOf("Checks failed"));
  });

  it("deploys to --bot, or the bot named in package.json", async () => {
    const { arena, run } = setUp();
    arena.addBot("greedy");
    expect(
      (await run(["deploy", "--skip-local-checks", "--bot", "greedy", "--no-wait"])).code,
    ).toBe(0);
    const cwd = botProject({
      "package.json": JSON.stringify({ name: "x", zerosnake: { bot: "greedy" } }),
    });
    const r = await run(["deploy", "--skip-local-checks", "--no-wait"], cwd);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("uploaded greedy v2");
    expect(r.out).toContain("zerosnake status");
    expect(arena.calls("GET", /versions\/\d/)).toHaveLength(0);
  });

  it("retries with the same Idempotency-Key and makes one version", async () => {
    const { arena, run } = setUp();
    arena.addBot("my-snake");
    arena
      .fail("POST", /versions$/, "network")
      .fail("POST", /versions$/, apiError(503, "unavailable", "Couldn't queue the checks."))
      .fail("POST", /versions$/, "lost")
      .fail("POST", /versions$/, apiError(409, "deploy_in_progress", "Still processing."));
    arena.fail("GET", /versions\/1$/, "network");
    const r = await run(["deploy", "--skip-local-checks"]);
    expect(r.code, r.err).toBe(0);
    const keys = arena.calls("POST", /versions$/).map((c) => c.headers.get("idempotency-key"));
    expect(keys).toHaveLength(5);
    expect(new Set(keys).size).toBe(1);
    expect(arena.versions).toHaveLength(1);
    expect(r.err).toContain("Upload didn't go through (ECONNRESET); retrying in 1s");
    expect(r.err).toContain("still processing the first attempt");
    expect(r.out).toContain("my-snake v1 passed the checks");
  });

  it("waits as long as Retry-After says before retrying", async () => {
    const { arena, slept, run } = setUp();
    arena.addBot("my-snake");
    arena.fail(
      "POST",
      /versions$/,
      Response.json(
        { error: "rate_limited", message: "Too many requests.", retryAfter: 30 },
        { status: 429, headers: { "retry-after": "30" } },
      ),
    );
    const r = await run(["deploy", "--skip-local-checks", "--no-wait"]);
    expect(r.code, r.err).toBe(0);
    expect(slept).toContain(30_000);
    expect(r.err).toContain("Upload didn't go through (too many requests); retrying in 30s");
    expect(arena.versions).toHaveLength(1);
  });

  it("stops at once, with a clear message, while an admin has paused deploys", async () => {
    const { arena, slept, run } = setUp();
    arena.addBot("my-snake");
    arena.fail(
      "POST",
      /versions$/,
      Response.json(
        {
          error: "deploys_paused",
          message:
            "Deploys are paused for now (maintenance). Nothing was deployed; try again later.",
        },
        { status: 503, headers: { "retry-after": "300" } },
      ),
    );
    const r = await run(["deploy", "--skip-local-checks"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Deploys are paused for now (maintenance)");
    expect(r.err).toContain("paused deploys for everyone; it isn't about your bot");
    expect(r.err).not.toContain("retrying");
    expect(arena.calls("POST", /versions$/)).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it("prints the report and exits 1 when the checks reject the version", async () => {
    const { arena, run } = setUp();
    arena.addBot("my-snake");
    arena.outcome = {
      status: "rejected",
      report: {
        ok: false,
        checks: [
          { name: "loads", ok: true },
          { name: "qualification", ok: false, message: "mean score 12.0, easy scored 29.5" },
        ],
      },
      polls: 1,
    };
    const r = await run(["deploy", "--skip-local-checks"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("my-snake v1 was rejected:");
    expect(r.err).toContain("✗ qualification: mean score 12.0, easy scored 29.5");
    expect(r.err).toContain("Nothing changed in the arena");
  });

  it("stops early when today's deploys are used up", async () => {
    const { arena, run } = setUp();
    arena.addBot("my-snake");
    arena.deploysToday = 20;
    const r = await run(["deploy"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/You've used all 20 deploys for today\. More at .+ \(00:00 UTC\)/);
    expect(r.out).not.toContain("bundles");
  });

  it("checks the limits locally before uploading", async () => {
    const { arena, run } = setUp();
    arena.addBot("my-snake");
    const r = await run(["deploy"], botProject({ "src/my notes.md": "# ideas" }));
    expect(r.code).toBe(1);
    expect(r.err).toContain("✗ source paths: src/my notes.md may only contain letters");
    expect(arena.calls("POST", /versions/)).toHaveLength(0);
  });

  it("counts meta in the upload size, exactly as sent", async () => {
    const { arena, run } = setUp();
    arena.addBot("my-snake");
    const cwd = botProject();
    const deploy = ["deploy", "--skip-local-checks", "--no-wait", "-m", "x".repeat(200)];
    expect((await run(deploy, cwd)).code).toBe(0);
    const sent = Buffer.byteLength(JSON.stringify(arena.calls("POST", /versions$/)[0]?.body));
    arena.limits = { ...arena.limits, maxBodyBytes: sent };
    expect((await run(deploy, cwd)).code).toBe(0);
    arena.limits = { ...arena.limits, maxBodyBytes: sent - 1 };
    const r = await run(deploy, cwd);
    expect(r.code).toBe(1);
    expect(r.err).toContain("✗ upload size");
    expect(arena.calls("POST", /versions$/)).toHaveLength(2);
  });

  it("doesn't retry an upload that's redirected", async () => {
    const { arena, slept, run } = setUp();
    arena.addBot("my-snake");
    arena.fail(
      "POST",
      /versions$/,
      new Response(null, { status: 308, headers: { location: "https://elsewhere.test/v" } }),
    );
    const r = await run(["deploy", "--skip-local-checks"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("redirected (HTTP 308 to https://elsewhere.test/v)");
    expect(r.err).not.toContain("retrying");
    expect(arena.calls("POST", /versions$/)).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it("explains the server's refusals", async () => {
    const { arena, run } = setUp();
    arena.addBot("my-snake");
    arena.fail(
      "POST",
      /versions$/,
      apiError(422, "sources_too_large", "Sources are 1.2 MB; the limit is 1 MB.", {
        limit: 1,
        actual: 2,
      }),
    );
    const r = await run(["deploy", "--skip-local-checks"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Sources are 1.2 MB; the limit is 1 MB.\nEverything under src/");

    arena.tokens.clear();
    const expired = await run(["deploy", "--skip-local-checks"]);
    expect(expired.code).toBe(1);
    expect(expired.err).toContain("didn't accept your login: it expired or was revoked");
  });

  it("gives up waiting after a while, leaving the checks running", async () => {
    const { arena, run } = setUp();
    arena.addBot("my-snake");
    arena.outcome = { ...arena.outcome, polls: 10_000 };
    const r = await run(["deploy", "--skip-local-checks"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("The server is still checking my-snake v1 after 10 minutes");
    expect(r.err).toContain("the checks aren't running on this server yet");
    expect(r.err).toContain("`--no-wait` skips the wait");
  });

  it("uses ZEROSNAKE_TOKEN when set (CI)", async () => {
    const arena = new FakeArena();
    arena.tokens.add("zsk_ci");
    arena.addBot("my-snake");
    const io = captureIo(botProject());
    const remote = arena.remote({
      ZEROSNAKE_TOKEN: "zsk_ci",
      ZEROSNAKE_CONFIG_DIR: makeProject({}),
    });
    expect(await main(["deploy", "--skip-local-checks", "--no-wait"], io, remote)).toBe(0);
    expect(arena.calls("POST", /versions$/)[0]?.headers.get("authorization")).toBe("Bearer zsk_ci");
  });
});

describe("zerosnake status", () => {
  it("shows bots, versions, ratings and deploys left", async () => {
    const { arena, run } = setUp();
    arena.addBot("greedy");
    arena.addBot("draft");
    arena.addBot("newbie");
    expect((await run(["deploy", "--skip-local-checks", "--bot", "greedy"])).code).toBe(0);
    expect((await run(["deploy", "--skip-local-checks", "--bot", "draft"])).code).toBe(0);
    arena.outcome = { ...arena.outcome, polls: 100 };
    expect(
      (await run(["deploy", "--skip-local-checks", "--bot", "greedy", "--no-wait"])).code,
    ).toBe(0);
    arena.ratings = {
      greedy: { rating: 312.44, ratingCi: 18.2, ratedLives: 64, ratedMinutes: 95.5, lives: 1234 },
      draft: { rating: 50, ratingCi: 40, ratedLives: 12, ratedMinutes: 20, lives: 12 },
    };

    const r = await run(["status"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`Logged in to ${SERVER} as @ada`);
    expect(r.out).toContain(`greedy ${SERVER}/@ada/greedy`);
    expect(r.out).toMatch(/active\s+v1\n\s+latest\s+v2 · validating · deployed 1 min ago/);
    expect(r.out).toContain("312.4 ± 18.2 pts/min over 64 lives, 1 h 35 min alive · ranked");
    expect(r.out).toContain("1,234 played (all versions)");
    expect(r.out).toContain(
      "50.0 ± 40.0 pts/min over 12 lives, 20 min alive · unranked until 60 minutes alive",
    );
    expect(r.out).toMatch(/newbie .+\n\s+active\s+none \(not in the arena\)/);
    expect(r.out).toMatch(/Deploys today: 3 of 20, 17 left \(resets at .+\)/);

    const one = await run(["status", "--bot", "draft"]);
    expect(one.out).not.toContain("greedy");
  });

  it("shows when the arena quarantined the active version", async () => {
    const { arena, run } = setUp();
    arena.addBot("my-snake");
    expect((await run(["deploy", "--skip-local-checks"])).code).toBe(0);
    const reason = "Its calls kept hitting the room's CPU limit.";
    const version = arena.versions.at(-1);
    if (version) version.info.quarantine = { at: "2026-10-27T10:00:00Z", reason };
    const r = await run(["status"]);
    expect(r.out).toMatch(
      /active\s+v1 · quarantined by the arena 2 h ago: no new lives until reviewed/,
    );
    const logs = await run(["logs"]);
    expect(logs.out).toContain("Quarantined by the arena");
    expect(logs.out).toContain(reason);
  });
});

describe("zerosnake logs", () => {
  it("shows the version and points at the site while the API has no lives", async () => {
    const { arena, run } = setUp();
    arena.addBot("my-snake");
    expect((await run(["deploy", "--skip-local-checks", "-m", "eat more"])).code).toBe(0);
    const r = await run(["logs"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("my-snake v1 · ready (active)");
    expect(r.out).toContain('"eat more"');
    expect(r.out).toContain("✓ loads");
    expect(r.out).toContain("This server can't list lives yet.");
    expect(r.out).toContain(`${SERVER}/@ada/my-snake?v=1`);
  });

  it("lists recent lives and how they ended", async () => {
    const { arena, run } = setUp();
    arena.addBot("my-snake");
    expect((await run(["deploy", "--skip-local-checks"])).code).toBe(0);
    arena.livesEndpoint = true;
    const life = {
      startedAt: "2026-10-27T10:00:00Z",
      score: 300,
      lengthMax: 80,
      kills: 2,
      killer: null,
    };
    arena.lives = [
      { ...life, id: "l3", endedAt: null, deathCause: null },
      {
        ...life,
        id: "l2",
        endedAt: "2026-10-27T10:05:00Z",
        deathCause: "collision",
        killer: "@bob/viper v2",
      },
      // Its replay expired (kept 2 days): no link.
      {
        ...life,
        id: "l1",
        endedAt: "2026-10-27T10:01:00Z",
        deathCause: "timeout",
        hasReplay: false,
      },
    ];
    // Run from elsewhere: with a single bot, logs picks it.
    const r = await run(["logs"], makeProject({}));
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("alive");
    expect(r.out).toContain("ran into @bob/viper v2");
    expect(r.out).toContain(`replay: ${SERVER}/replay/l2`);
    expect(r.out).not.toContain(`${SERVER}/replay/l1`);
    expect(r.out).toContain("too slow");

    const deaths = await run(["logs", "--deaths", "--version", "1"]);
    expect(deaths.out).not.toContain("alive");
    expect(arena.calls("GET", /\/lives\?/).at(-1)?.path).toBe(
      "/api/bots/my-snake/versions/1/lives?limit=20&deaths=1",
    );
  });

  it("--deaths shows what the bot saw, returned, spent and logged before its latest deaths", async () => {
    const { arena, run } = setUp();
    arena.addBot("my-snake");
    expect((await run(["deploy", "--skip-local-checks"])).code).toBe(0);
    arena.livesEndpoint = true;
    const life = { startedAt: "2026-10-27T10:00:00Z", score: 3, lengthMax: 9, kills: 0 };
    arena.lives = [
      {
        ...life,
        id: "l4",
        endedAt: "2026-10-27T10:09:00Z",
        deathCause: "wall",
        killer: null,
        hasTrace: true,
      },
      {
        ...life,
        id: "l3",
        endedAt: "2026-10-27T10:08:00Z",
        deathCause: "collision",
        killer: "@bob/viper v2",
        hasTrace: true,
      },
      {
        ...life,
        id: "l2",
        endedAt: "2026-10-27T10:07:00Z",
        deathCause: "wall",
        killer: null,
        hasTrace: false,
      },
      {
        ...life,
        id: "l1",
        endedAt: "2026-10-27T10:06:00Z",
        deathCause: "wall",
        killer: null,
        hasTrace: true,
      },
    ];
    arena.traces = {
      l3: traceFixture(),
      l4: apiError(410, "trace_expired", "This life's trace is gone: traces are kept 7 days."),
    };
    const r = await run(["logs", "--deaths", "--context", "2"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Life l4: This life's trace is gone");
    expect(r.out).toContain("Life l3: ran into @bob/viper v2 at room tick 160, after 60 ticks");
    expect(r.out).toContain(
      "60 bot calls, 0 errors, 1 timeouts; cost per tick: peak 90%, mean 4.0%",
    );
    expect(r.out).toContain("The room restarted at tick 120");
    expect(r.out).toContain("init log: hello");
    expect(r.out).toContain("Last 2 ticks");
    expect(r.out).toContain(
      "[58] head (1.5, -2) angle 0.3 length 12 wall 40.2 | 2 snakes, nearest @bob HEAD (length 30) gap 0.4 | 5 food, nearest 3.1 | turn -0.25 boost | 90%, 9 ops timeout",
    );
    expect(r.out).toContain("log: dodging bob");
    expect(r.out).toContain("error: over budget");
    expect(r.out).toContain("[59] head");
    expect(r.out).not.toContain("[57] head");
    // Three deaths with a trace at most, never one without.
    const asked = arena.calls("GET", /\/api\/lives\//).map((c) => c.path);
    expect(asked).toEqual(["/api/lives/l4/trace", "/api/lives/l3/trace", "/api/lives/l1/trace"]);
  });

  it("prints no control or bidi characters from a trace's logs", async () => {
    const { arena, run } = setUp();
    const trace = traceFixture();
    const nasty = "a\x1b[2Jb\x9b31mc\x7fd\u202ee\u2066f\ud800g\r\nh";
    trace.load = { log: [nasty], error: nasty };
    trace.full[59] = { ...(trace.full[59] as TraceTick), log: [nasty], error: nasty };
    arena.traces = { l3: trace };
    const r = await run(["logs", "--life", "l3"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("init log: a?[2Jb?31mc?d?e?f?g??h");
    expect(r.out).toContain("init error: a?[2Jb");
    expect(r.out).toContain("log: a?[2Jb?31mc?d?e?f?g??h");
    expect(r.out).toContain("error: a?[2Jb");
    for (const line of r.out.split("\n")) expect(printable(line)).toBe(line);
  });

  it("--life shows one life's death context, and why it can't", async () => {
    const { arena, run } = setUp();
    arena.traces = {
      l3: traceFixture(),
      theirs: apiError(403, "not_life_owner", "That life is someone else's bot's."),
    };
    const r = await run(["logs", "--life", `${SERVER}/replay/l3`]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Life l3: ran into @bob/viper v2");
    expect(r.out.match(/\] head/g)).toHaveLength(DEFAULT_CONTEXT);
    expect(r.out).toContain(`replay: ${SERVER}/replay/l3`);
    const other = await run(["logs", "--life", "theirs"]);
    expect(other.code).toBe(1);
    expect(other.err).toContain("someone else's");
    expect((await run(["logs", "--life", "x", "--context", "101"])).code).toBe(2);
  });

  it("shows why a version was rejected", async () => {
    const { arena, run } = setUp();
    arena.addBot("my-snake");
    arena.outcome = {
      status: "rejected",
      report: { ok: false, checks: [{ name: "loads", ok: false, message: "threw on load" }] },
      polls: 1,
    };
    await run(["deploy", "--skip-local-checks"]);
    const r = await run(["logs", "--version", "1"]);
    expect(r.out).toContain("my-snake v1 · rejected");
    expect(r.out).toContain("✗ loads: threw on load");
    const missing = await run(["logs", "--version", "7"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('Bot "my-snake" has no version 7.');
  });
});

describe("help", () => {
  it("covers the remote commands", async () => {
    for (const command of ["login", "logout", "deploy", "status", "logs"]) {
      const io = captureIo(".");
      expect(await main([command, "--help"], io)).toBe(0);
      expect(io.stdout()).toContain(`Usage: zerosnake ${command}`);
    }
    const io = captureIo(".");
    await main(["--help"], io);
    expect(io.stdout()).not.toContain("Coming soon: login");
  });
});

/** A life of 60 ticks that ran into @bob's head after a timeout. */
function traceFixture(): TraceResponse {
  const tick = (lifeTick: number): TraceTick => ({
    tick: 100 + lifeTick,
    lifeTick,
    turn: 0.1,
    boost: false,
    outcome: "ok",
    work: 1_000_000,
    ops: 1,
    log: [],
    seen: {
      x: 1,
      y: 2,
      angle: 0,
      length: 12,
      wall: 41,
      snakes: 1,
      food: 0,
      nearest: null,
      foodDist: null,
    },
  });
  const full = Array.from({ length: 60 }, (_, i) => tick(i));
  full[58] = {
    ...tick(58),
    turn: -0.25,
    boost: true,
    outcome: "timeout",
    error: "over budget",
    work: 9_000_000,
    ops: 9,
    log: ["dodging bob"],
    seen: {
      x: 1.5,
      y: -2,
      angle: 0.3,
      length: 12,
      wall: 40.2,
      snakes: 2,
      food: 5,
      nearest: { id: "lb", author: "bob", gap: 0.4, length: 30, head: true },
      foodDist: 3.1,
    },
  };
  return {
    format: 1,
    lifeId: "l3",
    versionId: "v1",
    roomId: "r",
    startTick: 100,
    endTick: 160,
    cause: "collision",
    killer: "v-bob",
    killerName: "@bob/viper v2",
    budget: { ops: 10, work: 10_000_000, logBytes: 1024 },
    totals: {
      ticks: 60,
      timeouts: 1,
      errors: 0,
      skipped: 0,
      maxWork: 9_000_000,
      sumWork: 24_000_000,
      maxOps: 9,
      logTicks: 1,
      logBytes: 11,
    },
    load: { log: ["hello"] },
    restarts: [120],
    sampleEvery: 1,
    sampled: [],
    events: [],
    full,
  };
}
