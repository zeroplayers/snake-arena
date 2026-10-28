import { describe, expect, it } from "vitest";
import { noRateLimit, type RateLimiter } from "./rate-limit";
import { handleShowcase, SHOWCASE_CLIENT_HEADER } from "./showcase";

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
  it("hands the upgrade to the arena with the client it came from, and nothing else", async () => {
    const a = arena();
    const request = new Request("https://staging.zerosnake.dev/api/showcase?slot=1", {
      // A browser can't speak for another client.
      headers: { ...upgrade, [SHOWCASE_CLIENT_HEADER]: "192.0.2.1" },
    });
    const response = await handleShowcase(request, a.fetcher, noRateLimit);
    expect(await response.text()).toBe("from the arena");
    expect(a.requests).toHaveLength(1);
    // One showcase room: the slot the page never used isn't passed on.
    expect(a.requests[0]?.url).toBe("https://arena/showcase");
    expect(a.requests[0]?.headers.get("upgrade")).toBe("websocket");
    expect(a.requests[0]?.headers.get(SHOWCASE_CLIENT_HEADER)).toBe("203.0.113.9");
  });

  it("names an IPv6 client by its /64, as the rate limit does", async () => {
    const a = arena();
    const request = new Request("https://staging.zerosnake.dev/api/showcase", {
      headers: { Upgrade: "websocket", "cf-connecting-ip": "2001:db8:1:2:3:4:5:6" },
    });
    await handleShowcase(request, a.fetcher, noRateLimit);
    expect(a.requests[0]?.headers.get(SHOWCASE_CLIENT_HEADER)).toBe("2001:db8:1:2::/64");
  });

  it("refuses plain requests and rate-limited clients without bothering the arena", async () => {
    const a = arena();
    const plain = new Request("https://staging.zerosnake.dev/api/showcase");
    expect((await handleShowcase(plain, a.fetcher, noRateLimit)).status).toBe(426);

    const keys: string[] = [];
    const limited: RateLimiter = {
      check: async (rule, key) => {
        keys.push(`${rule}:${key}`);
        return { ok: false, rule, limit: 300, period: 60, retryAfter: 60 };
      },
    };
    const request = new Request("https://staging.zerosnake.dev/api/showcase", {
      headers: upgrade,
    });
    expect((await handleShowcase(request, a.fetcher, limited)).status).toBe(429);
    expect(keys).toEqual(["ip:203.0.113.9"]);
    expect(a.requests).toHaveLength(0);
  });
});
