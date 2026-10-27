import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanUp, makeProject } from "../testing/project.ts";
import { Credentials, configDir, DEFAULT_URL, serverUrl } from "./config.ts";

afterAll(cleanUp);

describe("serverUrl", () => {
  it("takes --url, then ZEROSNAKE_URL, then the default", () => {
    expect(serverUrl(undefined, {})).toBe(DEFAULT_URL);
    expect(serverUrl(undefined, { ZEROSNAKE_URL: "https://a.example/" })).toBe("https://a.example");
    expect(serverUrl("http://localhost:3000", { ZEROSNAKE_URL: "https://a.example" })).toBe(
      "http://localhost:3000",
    );
  });

  it("refuses plain http off this machine, paths and non-URLs", () => {
    expect(() => serverUrl("http://arena.example", {})).toThrow(/must use https/);
    expect(serverUrl("http://127.0.0.1:8787", {})).toBe("http://127.0.0.1:8787");
    expect(() => serverUrl("https://arena.example/api", {})).toThrow(/only the server's address/);
    expect(() => serverUrl("arena", {})).toThrow(/isn't a URL/);
  });
});

describe("configDir", () => {
  it("follows each platform's convention, overridable with ZEROSNAKE_CONFIG_DIR", () => {
    expect(configDir({}, "darwin", "/Users/ada")).toBe(
      "/Users/ada/Library/Application Support/zerosnake",
    );
    expect(configDir({}, "linux", "/home/ada")).toBe("/home/ada/.config/zerosnake");
    expect(configDir({ XDG_CONFIG_HOME: "/cfg" }, "linux", "/home/ada")).toBe("/cfg/zerosnake");
    expect(configDir({ APPDATA: "C:\\AppData" }, "win32", "C:\\Users\\ada")).toBe(
      join("C:\\AppData", "zerosnake"),
    );
    expect(configDir({ ZEROSNAKE_CONFIG_DIR: "/x" }, "linux", "/home/ada")).toBe("/x");
  });
});

describe("Credentials", () => {
  it("keeps one token per server in a file only its owner can read", () => {
    const dir = join(makeProject({}), "nested", "zerosnake");
    const store = new Credentials(dir);
    expect(store.get("https://a.example")).toBeNull();

    store.set("https://a.example", { token: "zsk_a", username: "ada", savedAt: "now" });
    store.set("http://localhost:3000", { token: "zsk_b", username: "ada", savedAt: "now" });
    expect(store.get("https://a.example")?.token).toBe("zsk_a");
    expect(store.get("http://localhost:3000")?.token).toBe("zsk_b");
    if (process.platform !== "win32") {
      expect(statSync(store.file).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }

    expect(store.delete("https://a.example")).toBe(true);
    expect(store.delete("https://a.example")).toBe(false);
    expect(JSON.parse(readFileSync(store.file, "utf8")).servers).toEqual({
      "http://localhost:3000": expect.objectContaining({ token: "zsk_b" }),
    });
    store.delete("http://localhost:3000");
    expect(existsSync(store.file)).toBe(false);
  });

  it("says what to do with a damaged file", () => {
    const dir = makeProject({});
    writeFileSync(join(dir, "credentials.json"), "{nope");
    expect(() => new Credentials(dir).get("https://a.example")).toThrow(/is damaged/);
  });
});
