/**
 * End to end: apps/web's deploy API (`createCliApi`, what `zerosnake deploy` calls) and this
 * consumer on one D1, the same R2 buckets and the real (local) checks queue. A deploy ends in
 * `ready` or `rejected` by itself, as `GET /api/bots/:bot/versions/:n` shows the CLI.
 *
 * apps/web is loaded by path at run time so this package's typecheck doesn't pull in the site.
 */
import { join } from "node:path";
import type { CreateBotResponse, DeployResponse, VersionInfo } from "@zerosnake/web/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundle, createHarness, type Harness } from "./checks/testing/harness.ts";

type Handle = (request: Request, ...params: string[]) => Promise<Response>;
interface CliApi {
  createBot: Handle;
  deploy: Handle;
  getVersion: Handle;
}

const web = (path: string) => join(import.meta.dirname, "../../web/src", path);

const BASE = "http://localhost:3000";
const TOKEN = "zsk_e2e-token-e2e-token";

let h: Harness;
let api: CliApi;

beforeAll(async () => {
  h = await createHarness();
  const { createCliApi } = await import(web("server/cli-api.ts"));
  const { hashToken } = await import(web("server/cli-auth.ts"));
  api = createCliApi(h.web);
  await h.db.batch([
    h.db
      .prepare("INSERT INTO users (id, name, email, username) VALUES (?, ?, ?, ?)")
      .bind("user-e2e", "E2E", "e2e@example.com", "e2e"),
    h.db
      .prepare("INSERT INTO cli_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
      .bind("token-e2e", "user-e2e", await hashToken(TOKEN), Date.now() + 86_400_000),
  ]);
}, 60_000);

afterAll(async () => {
  await h?.dispose();
});

function request(path: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** What `zerosnake deploy` does: upload, then poll the version until it isn't `validating`. */
async function deploy(slug: string, code: string): Promise<VersionInfo> {
  const sources = [{ path: "src/bot.ts", content: code }];
  const response = await api.deploy(
    request(`/api/bots/${slug}/versions`, { bundle: code, sources }),
    slug,
  );
  expect(response.status).toBe(201);
  const { version } = (await response.json()) as DeployResponse;
  // Usually `validating`; with the local queue the checks can even end before the deploy API
  // has marked the row queued (the consumer doesn't wait for `enqueued_at`).
  if (version.status !== "validating") return version;
  const deadline = Date.now() + 120_000;
  for (;;) {
    const polled = await api.getVersion(
      request(`/api/bots/${slug}/versions/${version.n}`),
      slug,
      String(version.n),
    );
    const info = (await polled.json()) as VersionInfo;
    if (info.status !== "validating") return info;
    if (Date.now() > deadline) throw new Error(`${slug} v${version.n} is still validating`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe("deploy → checks", () => {
  it("ends an honest deploy in ready, and the next one replaces it", async () => {
    const created = await api.createBot(request("/api/bots", { name: "Honest" }));
    const { slug } = (await created.json()) as CreateBotResponse;

    const first = await deploy(
      slug,
      await bundle(`export { medium as default } from "@zerosnake/house-bots";`),
    );
    expect(first).toMatchObject({ n: 1, status: "ready", report: { ok: true } });

    const second = await deploy(
      slug,
      await bundle(`export { hard as default } from "@zerosnake/house-bots";`),
    );
    expect(second).toMatchObject({ n: 2, status: "ready" });
    const again = await api.getVersion(request(`/api/bots/${slug}/versions/1`), slug, "1");
    expect(((await again.json()) as VersionInfo).status).toBe("archived");
  }, 240_000);

  it("ends a bad deploy in rejected, with the report the CLI prints", async () => {
    const created = await api.createBot(request("/api/bots", { name: "Suicidal" }));
    const { slug } = (await created.json()) as CreateBotResponse;
    const rejected = await deploy(slug, `export default { tick() { return { turn: 0 }; } };`);
    expect(rejected.status).toBe("rejected");
    expect(rejected.report?.checks.find((c) => !c.ok)).toMatchObject({
      name: "qualification",
      message: expect.stringMatching(/^scores below easy/),
    });
  }, 120_000);
});
