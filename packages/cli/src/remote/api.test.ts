import { describe, expect, it } from "vitest";
import { apiError, FakeArena, htmlNotFound, SERVER } from "../testing/fake-arena.ts";
import { Api, ApiError, explain, isTransient, NetworkError, withRetries } from "./api.ts";

/** What `explain` says for a response to `GET /api/me`. */
async function explained(response: Response): Promise<string> {
  const arena = new FakeArena();
  arena.tokens.add("zsk_t");
  arena.fail("GET", /^\/api\/me$/, response);
  const error = await new Api(SERVER, arena.remote(), "zsk_t")
    .call("GET", "/api/me")
    .catch((e) => e);
  return explain(error, SERVER).message;
}

describe("Api", () => {
  it("sends the token and a user agent, and parses JSON", async () => {
    const arena = new FakeArena();
    arena.tokens.add("zsk_t");
    const me = await new Api(SERVER, arena.remote(), "zsk_t").call<{ user: unknown }>(
      "GET",
      "/api/me",
    );
    expect(me.user).toMatchObject({ username: "ada" });
    const [request] = arena.requests;
    expect(request?.headers.get("authorization")).toBe("Bearer zsk_t");
    expect(request?.headers.get("user-agent")).toMatch(/^zerosnake\/\S+ \(node /);
  });

  it("turns failures into ApiError (with the body) and NetworkError", async () => {
    const arena = new FakeArena().fail("GET", /^\/api\/me$/, "network");
    const api = new Api(SERVER, arena.remote(), "zsk_nope");
    const offline = (await api.call("GET", "/api/me").catch((e) => e)) as NetworkError;
    expect(offline).toBeInstanceOf(NetworkError);
    expect(offline.reason).toBe("ECONNRESET");
    const denied = (await api.call("GET", "/api/me").catch((e) => e)) as ApiError;
    expect(denied).toBeInstanceOf(ApiError);
    expect(denied.status).toBe(401);
    expect(denied.code).toBe("unauthorized");
  });
});

describe("explain", () => {
  it("puts every error shape in plain language", async () => {
    expect(await explained(apiError(401, "unauthorized", "Missing token."))).toContain(
      "Run `zerosnake login --url https://arena.test` again",
    );
    expect(await explained(new Response("", { status: 401 }))).toContain("expired or was revoked");
    expect(
      await explained(apiError(403, "not_bot_owner", "That bot belongs to someone else.")),
    ).toBe(
      "That bot belongs to someone else.\nPick one of your own bots with --bot (`zerosnake status` lists them).",
    );
    expect(await explained(apiError(409, "idempotency_conflict", "Key reused."))).toBe(
      "Key reused.",
    );
    expect(
      await explained(apiError(413, "body_too_large", "Request body is over 3 MB.")),
    ).toContain("too big to upload");
    expect(
      await explained(
        apiError(422, "bundle_too_large", "The bundle is 300 KB; the limit is 256 KB."),
      ),
    ).toContain("drop big tables");
    expect(
      await explained(
        apiError(429, "quota_exceeded", "x", {
          quota: { deploysToday: 20, deploysPerDay: 20, resetsAt: "2026-10-28T00:00:00.000Z" },
        }),
      ),
    ).toMatch(/^You've used all 20 deploys for today\. More at .+ \(00:00 UTC\)\.$/);
    expect(await explained(new Response("slow down", { status: 429 }))).toContain("busy");
    expect(await explained(apiError(503, "unavailable", "Couldn't store the upload."))).toContain(
      "Nothing was deployed",
    );
    expect(await explained(new Response("<html>", { status: 502 }))).toContain(
      "having trouble (HTTP 502)",
    );
    expect(await explained(htmlNotFound())).toContain("Is this a ZeroSnake server");
    expect(explain(new NetworkError("/api/me", "ENOTFOUND"), SERVER).message).toContain(
      "Couldn't reach https://arena.test (ENOTFOUND)",
    );
  });
});

describe("retries", () => {
  it("retry only what's safe to repeat", () => {
    const err = (status: number, error?: string) =>
      new ApiError(status, error ? { error, message: "" } : null, "/x");
    expect(isTransient(new NetworkError("/x", "timed out"))).toBe(true);
    expect(isTransient(err(503, "unavailable"))).toBe(true);
    expect(isTransient(err(500, "internal_error"))).toBe(true);
    expect(isTransient(err(502))).toBe(true);
    expect(isTransient(err(409, "deploy_in_progress"))).toBe(true);
    expect(isTransient(err(429))).toBe(true);
    expect(isTransient(err(429, "quota_exceeded"))).toBe(false);
    expect(isTransient(err(409, "idempotency_conflict"))).toBe(false);
    expect(isTransient(err(422, "bundle_too_large"))).toBe(false);
    expect(isTransient(err(401, "unauthorized"))).toBe(false);
  });

  it("back off up to a total wait, then give up", async () => {
    const remote = new FakeArena().remote();
    const slept: number[] = [];
    remote.sleep = async (ms) => {
      slept.push(ms);
    };
    let calls = 0;
    const result = await withRetries(remote, async () => {
      if (++calls < 3) throw new NetworkError("/x", "reset");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(slept).toEqual([1000, 2000]);

    slept.length = 0;
    const always = () => Promise.reject(new NetworkError("/x", "reset"));
    await expect(withRetries(remote, always, { maxWaitMs: 20_000 })).rejects.toThrow(NetworkError);
    expect(slept).toEqual([1000, 2000, 4000, 8000]);
  });
});
