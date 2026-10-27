import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestD1, type TestD1 } from "../test/d1";
import { checkLiveness, runLivenessCheck } from "./liveness";

const NOW = new Date("2026-10-27T12:00:00Z");
const minutesAgo = (m: number) => NOW.getTime() - m * 60_000;

let d1: TestD1;

beforeEach(async () => {
  d1 = await createTestD1();
  // Long ago, so the kill switch's last change doesn't count as recent activity.
  await d1.db.prepare("UPDATE arena_control SET updated_at = ?").bind(minutesAgo(10_000)).run();
  await d1.db.batch([
    d1.db.prepare("INSERT INTO users (id, name, email) VALUES ('u', 'U', 'u@example.com')"),
    d1.db.prepare("INSERT INTO bots (id, owner_id, name, slug) VALUES ('b', 'u', 'B', 'b')"),
  ]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await d1.dispose();
});

async function readyVersion(activatedMinutesAgo: number | null) {
  await d1.db
    .prepare(
      `INSERT INTO versions (id, bot_id, n, status, bundle_key, source_key, activated_at)
       VALUES ('v', 'b', 1, 'ready', 'b.js', 's.json', ?)`,
    )
    .bind(activatedMinutesAgo === null ? null : minutesAgo(activatedMinutesAgo))
    .run();
}

async function life(id: string, startedMinutesAgo: number, endedMinutesAgo: number | null) {
  await d1.db
    .prepare(
      `INSERT INTO lives (id, version_id, room, start_tick, started_at, ended_at)
       VALUES (?, 'v', 'r', 0, ?, ?)`,
    )
    .bind(
      id,
      minutesAgo(startedMinutesAgo),
      endedMinutesAgo === null ? null : minutesAgo(endedMinutesAgo),
    )
    .run();
}

const check = (env: { NO_LIVES_ALERT_MINUTES?: string } = {}) =>
  checkLiveness({ DB: d1.db, ...env }, NOW);

describe("checkLiveness", () => {
  it("is idle with no ready versions (house bots write no lives)", async () => {
    expect(await check()).toMatchObject({ status: "idle", readyVersions: 0 });
  });

  it("is stalled when ready versions got no lives for longer than the threshold", async () => {
    await readyVersion(60);
    await life("old", 50, 40);
    expect(await check()).toMatchObject({
      status: "stalled",
      minutesSinceActivity: 40,
      readyVersions: 1,
      thresholdMinutes: 15,
    });
    expect(await check({ NO_LIVES_ALERT_MINUTES: "45" })).toMatchObject({ status: "ok" });
  });

  it("counts a recent start or end of a life, and a recent activation, as activity", async () => {
    await readyVersion(600);
    await life("long", 300, 3);
    expect(await check()).toMatchObject({ status: "ok", minutesSinceActivity: 3 });

    await d1.db.prepare("DELETE FROM lives").run();
    expect(await check()).toMatchObject({ status: "stalled", minutesSinceActivity: 600 });
    await d1.db.prepare("UPDATE versions SET activated_at = ?").bind(minutesAgo(5)).run();
    expect(await check()).toMatchObject({ status: "ok", minutesSinceActivity: 5 });
  });

  it("is paused while the kill switch is on, and gives a resumed arena time", async () => {
    await readyVersion(600);
    await d1.db.prepare("UPDATE arena_control SET paused = 1").run();
    expect(await check()).toMatchObject({ status: "paused" });
    await d1.db
      .prepare("UPDATE arena_control SET paused = 0, updated_at = ?")
      .bind(minutesAgo(2))
      .run();
    expect(await check()).toMatchObject({ status: "ok", minutesSinceActivity: 2 });
  });

  it("is stalled when there was never any activity at all", async () => {
    await readyVersion(null);
    await d1.db.prepare("UPDATE arena_control SET updated_at = 0").run();
    expect(await check()).toMatchObject({ status: "stalled", minutesSinceActivity: null });
  });
});

describe("runLivenessCheck", () => {
  it("logs an error with the alert and writes the metric when stalled", async () => {
    await readyVersion(60);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const points: unknown[] = [];
    await runLivenessCheck({ DB: d1.db, METRICS: { writeDataPoint: (p) => points.push(p) } }, NOW);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        event: "arena.liveness",
        status: "stalled",
        alert: "no_lives",
      }),
    );
    expect(points).toEqual([
      {
        indexes: ["arena.liveness"],
        blobs: ["arena.liveness", "web", "stalled"],
        doubles: [1, 60, 1, 15],
      },
    ]);
  });

  it("logs info when fine, and never throws", async () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    await runLivenessCheck({ DB: d1.db }, NOW);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "arena.liveness", status: "idle" }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      prepare: () => {
        throw new Error("D1 down");
      },
    } as unknown as D1Database;
    expect(await runLivenessCheck({ DB: broken }, NOW)).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: "arena.liveness_failed" }));
  });
});
