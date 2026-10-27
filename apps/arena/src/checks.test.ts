import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bundle,
  createHarness,
  DEAD_LETTER_QUEUE,
  type Harness,
} from "./checks/testing/harness.ts";
import { STALE_AFTER_MS } from "./checks/versions.ts";

let h: Harness;
let medium: string;
let hard: string;

/** Plain JS bots, run in the sandbox as they are. */
const BOTS = {
  /** Drives straight into the wall every life: loads and runs, but can't qualify. */
  suicidal: `export default { tick() { return { turn: 0 }; } };`,
  /** About 90% of the op budget on every tick: over the suite's cap of half on average. */
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

  it("rejects a bot over the suite's cost caps", async () => {
    const { job } = await h.deploy("slow", BOTS.nearBudget);
    await h.deliver(job);
    const v = await h.version(job.versionId);
    expect(v?.status).toBe("rejected");
    expect(v?.report?.suite?.run.overrun?.limit).toBe("maxInterrupts");
    const failed = v?.report?.checks.find((c) => !c.ok);
    expect(failed).toMatchObject({ name: "seeds", message: expect.stringMatching(/^too slow/) });
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
    const { job } = await h.deploy("lost-upload", `${BOTS.suicidal} // lost-upload`);
    await h.bundles.delete(job.bundleKey);
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
    const unqueued = await h.deploy("unqueued", BOTS.suicidal, { enqueuedAt: null });
    await h.db
      .prepare("UPDATE versions SET created_at = ? WHERE id = ?")
      .bind(now - 2 * STALE_AFTER_MS, unqueued.job.versionId)
      .run();

    await h.cron(now);
    expect(await h.version(stale.job.versionId)).toMatchObject({
      status: "rejected",
      report: { reason: "checks_failed_to_complete" },
    });
    expect((await h.version(recent.job.versionId))?.status).toBe("validating");
    // The deploy API's to end.
    expect((await h.version(unqueued.job.versionId))?.status).toBe("validating");
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
    await h.bundles.delete(job.bundleKey);
    await h.send(job);
    expect(await h.settled(job.versionId, 60_000)).toMatchObject({
      status: "rejected",
      report: { reason: "checks_failed_to_complete" },
    });
  }, 90_000);
});
