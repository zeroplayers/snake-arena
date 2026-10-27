import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bundle,
  createHarness,
  DEAD_LETTER_QUEUE,
  type Harness,
} from "./checks/testing/harness.ts";
import { STALE_AFTER_MS } from "./checks/versions.ts";
import { metricsNamed } from "./testing/metrics.ts";

let h: Harness;
let medium: string;

/** Drives straight into the wall every life: loads and runs, but can't qualify. */
const SUICIDAL = `export default { tick() { return { turn: 0 }; } };`;

beforeAll(async () => {
  [h, medium] = await Promise.all([
    createHarness({ metrics: "record" }),
    bundle(`export { medium as default } from "@zerosnake/house-bots";`),
  ]);
}, 60_000);

afterAll(async () => {
  await h?.dispose();
});

/** The `checks.finished` points written since the test's previous call. */
let seen = 0;
async function finished() {
  const all = metricsNamed(await h.metricPoints(), "checks.finished");
  const fresh = all.slice(seen);
  seen = all.length;
  return fresh;
}

describe("checks consumer metrics", () => {
  it("writes checks.finished for a ready and a rejected version", async () => {
    const honest = await h.deploy("honest", medium);
    await h.deliver(honest.job);
    expect(await finished()).toEqual([
      { outcome: "ready", reason: null, durationMs: expect.any(Number), attempt: 1 },
    ]);

    const bad = await h.deploy("suicidal", SUICIDAL);
    await h.deliver(bad.job, { attempts: 2 });
    // The first failed check names it.
    expect(await finished()).toEqual([
      { outcome: "rejected", reason: "qualification", durationMs: expect.any(Number), attempt: 2 },
    ]);

    // A redelivery finds it done.
    await h.deliver(bad.job, { attempts: 3 });
    expect(await finished()).toMatchObject([{ outcome: "unchanged", reason: null, attempt: 3 }]);
  }, 60_000);

  it("writes failed for each retried delivery, dead_letter when it gives up", async () => {
    const { job } = await h.deploy("r2-error", `${SUICIDAL} // r2-error`);
    // R2 refuses keys over 1024 bytes: every read of the bundle throws.
    await h.db
      .prepare("UPDATE versions SET bundle_key = ? WHERE id = ?")
      .bind(`${"x".repeat(1025)}.js`, job.versionId)
      .run();
    expect(await h.deliver(job)).toEqual({ acked: false, retried: true });
    expect(await finished()).toEqual([
      { outcome: "failed", reason: expect.any(String), durationMs: expect.any(Number), attempt: 1 },
    ]);
    await h.deliver(job, { queue: DEAD_LETTER_QUEUE, attempts: 4 });
    expect(await finished()).toEqual([
      { outcome: "dead_letter", reason: "rejected", durationMs: expect.any(Number), attempt: 4 },
    ]);
  });

  it("writes malformed for a message that isn't a job, missing for a version that's gone", async () => {
    await h.deliver({ nonsense: true });
    const { job } = await h.deploy("gone", SUICIDAL);
    await h.db.prepare("DELETE FROM versions WHERE id = ?").bind(job.versionId).run();
    await h.deliver(job);
    expect((await finished()).map((m) => [m.outcome, m.reason])).toEqual([
      ["malformed", null],
      ["missing", null],
    ]);
  });

  it("writes reaped for each version the cron rejects", async () => {
    const now = Date.now();
    await h.deploy("stale", SUICIDAL, { enqueuedAt: now - STALE_AFTER_MS - 1 });
    await h.cron(now);
    expect(await finished()).toEqual([
      { outcome: "reaped", reason: "checks_failed_to_complete", durationMs: 0, attempt: 0 },
    ]);
  });
});
