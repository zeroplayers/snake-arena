import { DEFAULT_CONFIG, rulesId } from "@zerosnake/engine";
import { checkReportLines } from "@zerosnake/web/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bundle,
  createHarness,
  DEAD_LETTER_QUEUE,
  type Harness,
} from "./checks/testing/harness.ts";
import { STALE_AFTER_MS, UNQUEUED_AFTER_MS } from "./checks/versions.ts";

let h: Harness;
let medium: string;
let hard: string;

/** Plain JS bots, run in the sandbox as they are. */
const BOTS = {
  /** Drives straight into the wall every life: loads and runs, but can't qualify. */
  suicidal: `export default { tick() { return { turn: 0 }; } };`,
  /**
   * A heavy loop on every tick. Under the instrumented meter (#60) it goes over the per-tick
   * budget, so the sandbox kills it after 3 ticks in a row, before any suite-level cap is reached.
   */
  nearBudget: `export default { tick(state) {
    let x = 0; for (let i = 0; i < 40000; i++) x += i * 0.5;
    return { turn: x > 0 ? 0.2 : -0.2 };
  } };`,
};

beforeAll(async () => {
  [h, medium, hard] = await Promise.all([
    createHarness(),
    bundle(`export { medium as default } from "@zerosnake/house-bots";`),
    bundle(`export { hard as default } from "@zerosnake/house-bots";`),
  ]);
}, 60_000);

afterAll(async () => {
  await h?.dispose();
});

/** Makes every R2 read of the version's bundle throw: R2 refuses keys over 1024 bytes. */
async function breakR2(versionId: string) {
  await h.db
    .prepare("UPDATE versions SET bundle_key = ? WHERE id = ?")
    .bind(`${"x".repeat(1025)}.js`, versionId)
    .run();
}

/** Every version of `botId`, oldest first. */
async function statuses(botId: string) {
  const { results } = await h.db
    .prepare("SELECT n, status FROM versions WHERE bot_id = ? ORDER BY n")
    .bind(botId)
    .all<{ n: number; status: string }>();
  return results;
}

describe("checks consumer", () => {
  it("makes an honest bot ready, archiving its previous ready version", async () => {
    const first = await h.deploy("honest", medium);
    expect(await h.deliver(first.job)).toEqual({ acked: true, retried: false });
    const v1 = await h.version(first.job.versionId);
    expect(v1).toMatchObject({ status: "ready" });
    expect(v1?.activatedAt).toEqual(expect.any(Number));
    expect(v1?.report).toMatchObject({
      ok: true,
      checks: [
        { name: "limits", ok: true },
        { name: "loads", ok: true },
        { name: "seeds", ok: true },
        { name: "qualification", ok: true },
      ],
      qualificationScore: expect.any(Number),
      suite: { version: 1, passed: true, ticks: 1000 },
    });
    expect(v1?.report?.suite?.seeds).toHaveLength(5);
    expect(v1?.report?.text).toMatch(/^Checks passed/);

    const second = await h.deploy("honest", hard, { n: 2 });
    await h.deliver(second.job);
    const v2 = await h.version(second.job.versionId);
    expect(v2).toMatchObject({ status: "ready" });
    expect(v2?.activatedAt).toBeGreaterThanOrEqual(v1?.activatedAt ?? Infinity);
    expect(await statuses(first.botId)).toEqual([
      { n: 1, status: "archived" },
      { n: 2, status: "ready" },
    ]);
    // Archiving the old one keeps its stint and report.
    expect(await h.version(first.job.versionId)).toMatchObject({
      activatedAt: v1?.activatedAt,
      report: v1?.report,
    });
  }, 120_000);

  it("is a no-op on redelivery of a finished job", async () => {
    const { job } = await h.deploy("redelivered", medium);
    await h.deliver(job);
    const done = await h.version(job.versionId);
    expect(done?.status).toBe("ready");
    await new Promise((r) => setTimeout(r, 5));

    expect(await h.deliver(job, { attempts: 2 })).toEqual({ acked: true, retried: false });
    expect(await h.deliver(job, { queue: DEAD_LETTER_QUEUE })).toEqual({
      acked: true,
      retried: false,
    });
    expect(await h.version(job.versionId)).toEqual(done);
  }, 120_000);

  it("lets only one of two concurrent deliveries write", async () => {
    const { job } = await h.deploy("twice", BOTS.suicidal);
    const results = await Promise.all([h.deliver(job), h.deliver(job, { attempts: 2 })]);
    expect(results.every((r) => r.acked)).toBe(true);
    expect((await h.version(job.versionId))?.status).toBe("rejected");
  }, 60_000);

  it("keeps a version that passes after a newer one became ready as archived", async () => {
    const older = await h.deploy("late", medium);
    const newer = await h.deploy("late", hard, { n: 2 });
    await h.deliver(newer.job);
    await h.deliver(older.job);
    expect(await statuses(older.botId)).toEqual([
      { n: 1, status: "archived" },
      { n: 2, status: "ready" },
    ]);
    const passedLate = await h.version(older.job.versionId);
    expect(passedLate?.activatedAt).toBeNull();
    expect(passedLate?.report?.ok).toBe(true);
  }, 120_000);

  it("rejects a bad bot with its report", async () => {
    const { job } = await h.deploy("suicidal", BOTS.suicidal);
    expect(await h.deliver(job)).toEqual({ acked: true, retried: false });
    const v = await h.version(job.versionId);
    expect(v).toMatchObject({ status: "rejected", activatedAt: null });
    expect(v?.report).toMatchObject({ ok: false, suite: { passed: false } });
    expect(v?.report?.checks.map((c) => [c.name, c.ok])).toEqual([
      ["limits", true],
      ["loads", true],
      ["seeds", true],
      ["qualification", false],
    ]);
    expect(v?.report?.checks[3]?.message).toMatch(/^scores below easy/);
    expect(v?.report?.text).toMatch(/^Checks failed/);
  }, 60_000);

  it("says when the author's CLI tested on other rules than the arena's", async () => {
    // zerosnake@0.1.0 sends no `rules`: it plays turnRate 0.25 (#98).
    const old = await h.deploy("old-cli", BOTS.suicidal, { meta: { cliVersion: "0.1.0" } });
    await h.deliver(old.job);
    const v = await h.version(old.job.versionId);
    expect(v?.status).toBe("rejected");
    // Its own failed check, after the suite's: what every CLI prints for a check it doesn't know.
    expect(v?.report?.checks.map((c) => [c.name, c.ok])).toEqual([
      ["limits", true],
      ["loads", true],
      ["seeds", true],
      ["qualification", false],
      ["rules", false],
    ]);
    expect(v?.report?.checks[3]?.message).not.toMatch(/other rules/);
    expect(checkReportLines(v?.report)).toContainEqual(
      expect.stringMatching(
        /^Local rules: zerosnake 0\.1\.0 tested this version on other rules than the arena's \(a turn rate of 0\.25; the arena's is 0\.4\).*npx zerosnake@latest/,
      ),
    );
    // A CLI on the arena's rules gets the plain verdict.
    const current = await h.deploy("new-cli", BOTS.suicidal, {
      meta: { cliVersion: "0.1.1", rules: rulesId(DEFAULT_CONFIG) },
    });
    await h.deliver(current.job);
    const w = await h.version(current.job.versionId);
    expect(w?.report?.checks.map((c) => c.name)).not.toContain("rules");
  }, 120_000);

  it("rejects a bot that is too slow on every tick", async () => {
    const { job } = await h.deploy("slow", BOTS.nearBudget);
    await h.deliver(job);
    const v = await h.version(job.versionId);
    expect(v?.status).toBe("rejected");
    const failed = v?.report?.checks.find((c) => !c.ok);
    expect(failed).toMatchObject({
      name: "seeds",
      message: expect.stringMatching(/3 ticks in a row over budget/),
    });
  }, 120_000);

  it("rejects a bot over the upload limits without running it", async () => {
    const { job } = await h.deploy("huge", BOTS.suicidal, {
      sources: [{ path: "src/big.ts", content: "x".repeat(1024 * 1024 + 1) }],
    });
    await h.deliver(job);
    const v = await h.version(job.versionId);
    expect(v?.status).toBe("rejected");
    expect(v?.report?.checks).toEqual([
      { name: "limits", ok: false, message: expect.stringContaining("over the upload limits") },
    ]);
  });

  it("rejects objects in R2 over the upload limits without reading them", async () => {
    const bundleJob = (await h.deploy("huge-bundle", BOTS.suicidal)).job;
    await h.bundles.put(bundleJob.bundleKey, "x".repeat(256 * 1024 + 1));
    expect(await h.deliver(bundleJob)).toEqual({ acked: true, retried: false });
    expect(await h.version(bundleJob.versionId)).toMatchObject({
      status: "rejected",
      report: {
        ok: false,
        reason: "input_too_large",
        checks: [
          {
            name: "limits",
            ok: false,
            message: "over the upload limits: bundle is 262145 B (max 256 KiB)",
          },
        ],
      },
    });

    const archiveJob = (await h.deploy("huge-archive", BOTS.suicidal)).job;
    await h.sources.put(archiveJob.sourceKey, "x".repeat(8 * 1024 * 1024 + 1));
    expect(await h.deliver(archiveJob)).toEqual({ acked: true, retried: false });
    const v = await h.version(archiveJob.versionId);
    expect(v).toMatchObject({ status: "rejected", report: { reason: "input_too_large" } });
    expect(v?.report?.checks).toEqual([
      {
        name: "limits",
        ok: false,
        message: "over the upload limits: the source archive is 8 MiB (max 1 MiB of source)",
      },
    ]);
    expect(v?.report?.suite).toBeUndefined();
  });

  it("rejects a version whose upload is missing from R2 at once, without retrying", async () => {
    const lostBundle = (await h.deploy("lost-bundle", `${BOTS.suicidal} // lost-bundle`)).job;
    await h.bundles.delete(lostBundle.bundleKey);
    const lostSources = (await h.deploy("lost-sources", `${BOTS.suicidal} // lost-sources`)).job;
    await h.sources.delete(lostSources.sourceKey);
    for (const job of [lostBundle, lostSources]) {
      expect(await h.deliver(job)).toEqual({ acked: true, retried: false });
      const v = await h.version(job.versionId);
      expect(v).toMatchObject({
        status: "rejected",
        report: { ok: false, reason: "input_missing" },
      });
      expect(v?.report?.checks).toEqual([
        { name: "deploy", ok: false, message: expect.stringMatching(/wasn't found/) },
      ]);
    }
  });

  it("rejects a version whose source archive is malformed at once, without retrying", async () => {
    const malformed = [
      "not json",
      JSON.stringify({ format: "zerosnake-sources@2", files: [] }),
      JSON.stringify({ format: "zerosnake-sources@1", files: [{ path: "src/bot.ts" }] }),
      "null",
    ];
    for (const [i, text] of malformed.entries()) {
      const { job } = await h.deploy(`malformed-${i}`, `${BOTS.suicidal} // malformed-${i}`);
      await h.sources.put(job.sourceKey, text);
      expect(await h.deliver(job)).toEqual({ acked: true, retried: false });
      expect(await h.version(job.versionId)).toMatchObject({
        status: "rejected",
        report: { ok: false, reason: "input_malformed", checks: [{ name: "deploy", ok: false }] },
      });
    }
  });

  it("acks jobs for missing, finished or malformed versions without writing", async () => {
    expect(
      await h.deliver({ ...(await h.deploy("ghost", medium)).job, versionId: "no-such-version" }),
    ).toEqual({ acked: true, retried: false });
    expect(await h.version("no-such-version")).toBeNull();

    expect(await h.deliver({ versionId: "old-stub-shape" })).toEqual({
      acked: true,
      retried: false,
    });

    const { job } = await h.deploy("finished", medium);
    await h.db
      .prepare("UPDATE versions SET status = 'rejected', report = '{\"ok\":false}' WHERE id = ?")
      .bind(job.versionId)
      .run();
    const before = await h.version(job.versionId);
    expect(await h.deliver(job)).toEqual({ acked: true, retried: false });
    expect(await h.version(job.versionId)).toEqual(before);
  });

  it("never makes an archived bot's version ready", async () => {
    const live = await h.deploy("archived", medium);
    await h.deliver(live.job);
    const pending = await h.deploy("archived", hard, { n: 2 });

    // What the site's archiveBot does, in one batch: archive the bot and its ready version,
    // reject its validating ones.
    const at = Date.now();
    await h.db.batch([
      h.db.prepare("UPDATE bots SET archived_at = ? WHERE id = ?").bind(at, live.botId),
      h.db
        .prepare("UPDATE versions SET status = 'archived' WHERE bot_id = ? AND status = 'ready'")
        .bind(live.botId),
      h.db
        .prepare(
          "UPDATE versions SET status = 'rejected', report = '{\"ok\":false,\"checks\":[]}' WHERE bot_id = ? AND status = 'validating'",
        )
        .bind(live.botId),
    ]);
    const rejected = await h.version(pending.job.versionId);
    expect(await h.deliver(pending.job)).toEqual({ acked: true, retried: false });
    expect(await h.version(pending.job.versionId)).toEqual(rejected);

    // A validating version of an archived bot (shouldn't exist): rejected, not run.
    const stray = await h.deploy("archived", medium, { n: 3 });
    await h.deliver(stray.job);
    const v = await h.version(stray.job.versionId);
    expect(v?.status).toBe("rejected");
    expect(v?.report).toMatchObject({ reason: "bot_archived" });
    expect(await statuses(live.botId)).toEqual([
      { n: 1, status: "archived" },
      { n: 2, status: "rejected" },
      { n: 3, status: "rejected" },
    ]);
  }, 120_000);

  it("retries a job it can't run, then rejects the version from the dead-letter queue", async () => {
    const { job } = await h.deploy("r2-error", `${BOTS.suicidal} // r2-error`);
    await breakR2(job.versionId);
    expect(await h.deliver(job)).toEqual({ acked: false, retried: true });
    expect((await h.version(job.versionId))?.status).toBe("validating");

    expect(await h.deliver(job, { queue: DEAD_LETTER_QUEUE })).toEqual({
      acked: true,
      retried: false,
    });
    const v = await h.version(job.versionId);
    expect(v).toMatchObject({
      status: "rejected",
      report: { ok: false, reason: "checks_failed_to_complete" },
    });
    expect(v?.report?.checks[0]).toMatchObject({ name: "deploy", ok: false });
  });

  it("rejects versions whose job was lost, from the cron", async () => {
    const now = Date.now();
    const stale = await h.deploy("stale", BOTS.suicidal, { enqueuedAt: now - STALE_AFTER_MS - 1 });
    const recent = await h.deploy("recent", BOTS.suicidal, { enqueuedAt: now - 60_000 });
    await h.cron(now);
    expect(await h.version(stale.job.versionId)).toMatchObject({
      status: "rejected",
      report: { reason: "checks_failed_to_complete" },
    });
    expect((await h.version(recent.job.versionId))?.status).toBe("validating");
  });

  it("rejects versions whose deploy died before queueing them, from the cron", async () => {
    const now = Date.now();
    const created = async (bot: string, createdAt: number) => {
      const { job } = await h.deploy(bot, BOTS.suicidal, { enqueuedAt: null });
      await h.db
        .prepare("UPDATE versions SET created_at = ?, idempotency_key = ? WHERE id = ?")
        .bind(createdAt, `key-${bot}`, job.versionId)
        .run();
      return job.versionId;
    };
    const dead = await created("never-queued", now - UNQUEUED_AFTER_MS - 1);
    const inFlight = await created("in-flight", now - 1_000);

    await h.cron(now);
    expect(await h.version(dead)).toMatchObject({
      status: "rejected",
      report: { ok: false, reason: "enqueue_failed", checks: [{ name: "deploy", ok: false }] },
    });
    // As the deploy API's `abandon` leaves it: not counted against the quota, key released.
    expect(
      await h.db
        .prepare(
          "SELECT enqueued_at AS enqueuedAt, idempotency_key AS key FROM versions WHERE id = ?",
        )
        .bind(dead)
        .first(),
    ).toEqual({ enqueuedAt: null, key: null });
    expect((await h.version(inFlight))?.status).toBe("validating");
  });
});

describe("checks queue", () => {
  it("ends a version sent on the queue, as after a deploy", async () => {
    const { job } = await h.deploy("queued", medium);
    await h.send(job);
    expect(await h.settled(job.versionId)).toMatchObject({ status: "ready" });
  }, 120_000);

  it("rejects a version whose job fails on every delivery, through the dead-letter queue", async () => {
    const { job } = await h.deploy("always-failing", `${BOTS.suicidal} // always-failing`);
    await breakR2(job.versionId);
    await h.send(job);
    expect(await h.settled(job.versionId, 60_000)).toMatchObject({
      status: "rejected",
      report: { reason: "checks_failed_to_complete" },
    });
  }, 90_000);
});
