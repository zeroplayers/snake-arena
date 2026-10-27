/**
 * Keeps the Privacy Policy's cookie list honest: every cookie the site sets is listed there, and
 * the site's own code stores nothing else in the browser (no consent banner needed).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "./server/auth";
import { siteConfig } from "./server/site-config";
import { createTestD1 } from "./test/d1";
import { mockGithub } from "./test/github";

const SRC = import.meta.dirname;
const privacy = readFileSync(join(SRC, "routes/privacy.tsx"), "utf8");

afterEach(() => vi.unstubAllGlobals());

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("cookies and browser storage", () => {
  it("lists every cookie a GitHub sign-in sets on the HTTPS site", async () => {
    const base = "https://arena.example";
    const d1 = await createTestD1();
    try {
      const auth = createAuth({
        DB: d1.db,
        AUTH_KV: d1.kv,
        BETTER_AUTH_URL: base,
        BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
        GITHUB_CLIENT_ID: "test-client-id",
        GITHUB_CLIENT_SECRET: "test-client-secret",
      });
      mockGithub({ id: 1, login: "ada", name: "ada", email: "ada@example.com" });
      const start = await auth.handler(
        new Request(`${base}/api/auth/sign-in/social`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: base },
          body: JSON.stringify({ provider: "github", callbackURL: "/welcome" }),
        }),
      );
      const { url } = (await start.json()) as { url: string };
      const state = new URL(url).searchParams.get("state");
      const cookie = start.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
      const callback = await auth.handler(
        new Request(`${base}/api/auth/callback/github?code=c&state=${state}`, {
          headers: { cookie },
        }),
      );
      const names = new Set(
        [...start.headers.getSetCookie(), ...callback.headers.getSetCookie()].map(
          (c) => c.split("=")[0] ?? "",
        ),
      );
      expect([...names].sort()).toEqual([
        "__Secure-better-auth.session_token",
        "__Secure-better-auth.state",
      ]);
      for (const name of names) expect(privacy).toContain(`<code>${name}</code>`);
    } finally {
      await d1.dispose();
    }
  });

  it("the site's code doesn't touch cookies, localStorage, sessionStorage or IndexedDB", () => {
    const offenders = sourceFiles(SRC).filter((path) =>
      /\b(localStorage|sessionStorage|indexedDB|document\.cookie)\b/.test(
        readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""),
      ),
    );
    expect(offenders.map((p) => p.slice(SRC.length + 1))).toEqual([]);
  });
});

describe("Web Analytics config", () => {
  it("loads the beacon only with a token, outside development", () => {
    expect(siteConfig({ ENVIRONMENT: "staging", CF_BEACON_TOKEN: " abc " })).toEqual({
      beaconToken: "abc",
    });
    expect(siteConfig({ ENVIRONMENT: "staging", CF_BEACON_TOKEN: "" })).toEqual({
      beaconToken: null,
    });
    expect(siteConfig({ ENVIRONMENT: "development", CF_BEACON_TOKEN: "abc" })).toEqual({
      beaconToken: null,
    });
    expect(siteConfig({})).toEqual({ beaconToken: null });
  });
});
