import { describe, expect, it } from "vitest";
import { noRateLimit, type RateLimiter } from "./rate-limit";
import { handleShowcase } from "./showcase";

const upgrade = { Upgrade: "websocket", "cf-connecting-ip": "203.0.113.9" };

/** The `ARENA` service binding, recording what it was asked. */
function arena() {
  const requests: Request[] = [];
  const fetcher = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response("from the arena", { status: 503 });
    },
  } as unknown as Fetcher;
  return { fetcher, requests };
}

describe("/api/showcase", () => {
  it("hands the upgrade to the arena's /showcase, slot and headers included", async () => {
    const a = arena();
    const request = new Request("https://arena.surninsynergy.dev/api/showcase?slot=1", {
      headers: upgrade,
    });
    const response = await handleShowcase(request, a.fetcher, noRateLimit);
    expect(await response.text()).toBe("from the arena");
    expect(a.requests).toHaveLength(1);
    expect(a.requests[0]?.url).toBe("https://arena/showcase?slot=1");
    expect(a.requests[0]?.headers.get("upgrade")).toBe("websocket");
  });

  it("refuses plain requests and rate-limited clients without bothering the arena", async () => {
    const a = arena();
    const plain = new Request("https://arena.surninsynergy.dev/api/showcase");
    expect((await handleShowcase(plain, a.fetcher, noRateLimit)).status).toBe(426);

    const keys: string[] = [];
    const limited: RateLimiter = {
      check: async (rule, key) => {
        keys.push(`${rule}:${key}`);
        return { ok: false, rule, limit: 300, period: 60, retryAfter: 60 };
      },
    };
    const request = new Request("https://arena.surninsynergy.dev/api/showcase", {
      headers: upgrade,
    });
    expect((await handleShowcase(request, a.fetcher, limited)).status).toBe(429);
    expect(keys).toEqual(["ip:203.0.113.9"]);
    expect(a.requests).toHaveLength(0);
  });
});
