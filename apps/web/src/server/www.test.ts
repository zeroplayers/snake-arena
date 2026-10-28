import { describe, expect, it } from "vitest";
import { wwwRedirect } from "./www";

describe("wwwRedirect", () => {
  it("sends www. to the bare host with path and query", () => {
    const response = wwwRedirect(new Request("https://www.zerosnake.dev/docs/rules?x=1#top"));
    expect(response?.status).toBe(301);
    expect(response?.headers.get("location")).toBe("https://zerosnake.dev/docs/rules?x=1#top");
  });

  it("leaves other hosts alone", () => {
    expect(wwwRedirect(new Request("https://zerosnake.dev/"))).toBeNull();
    expect(wwwRedirect(new Request("http://localhost:3000/leaderboard"))).toBeNull();
  });
});
