import { describe, expect, it } from "vitest";
import { MAX_SHOWN_CHARS, parseSourceArchive, readSources, SOURCE_ARCHIVE_FORMAT } from "./sources";

const archive = (files: unknown, format: unknown = SOURCE_ARCHIVE_FORMAT) =>
  JSON.stringify({ format, files });

describe("parseSourceArchive", () => {
  it("returns the files sorted by path, content untouched", () => {
    const html = '<script>alert("x")</script>';
    const files = parseSourceArchive(
      archive([
        { path: "src/bot.ts", content: html },
        { path: "package.json", content: "{}" },
      ]),
    );
    expect(files?.map((f) => f.path)).toEqual(["package.json", "src/bot.ts"]);
    expect(files?.[1]).toEqual({
      path: "src/bot.ts",
      content: html,
      truncated: false,
      bidi: false,
    });
  });

  it("rejects anything that isn't a SourceArchive", () => {
    expect(parseSourceArchive("not json")).toBeNull();
    expect(parseSourceArchive("null")).toBeNull();
    expect(parseSourceArchive(archive([], "zerosnake-sources@2"))).toBeNull();
    expect(parseSourceArchive(archive({}))).toBeNull();
    expect(parseSourceArchive(archive([{ path: "a.ts" }]))).toBeNull();
    expect(parseSourceArchive(archive([{ path: "", content: "" }]))).toBeNull();
    expect(parseSourceArchive(archive([{ path: 1, content: "" }]))).toBeNull();
  });

  it("flags bidirectional control characters", () => {
    const [file] = parseSourceArchive(archive([{ path: "a.ts", content: "x‮y" }])) ?? [];
    expect(file?.bidi).toBe(true);
  });

  it("cuts very long files", () => {
    const content = "x".repeat(MAX_SHOWN_CHARS + 10);
    const [file] = parseSourceArchive(archive([{ path: "a.ts", content }])) ?? [];
    expect(file?.content).toHaveLength(MAX_SHOWN_CHARS);
    expect(file?.truncated).toBe(true);
  });
});

describe("readSources", () => {
  const bucket = (objects: Record<string, string>) =>
    ({
      get: async (key: string) => {
        const text = objects[key];
        return text === undefined ? null : { text: async () => text };
      },
    }) as unknown as R2Bucket;

  it("reads an archive, reports missing and invalid objects", async () => {
    const b = bucket({
      ok: archive([{ path: "a.ts", content: "1" }]),
      bad: "PK\u0003\u0004 a zip",
    });
    expect(await readSources(b, "ok")).toMatchObject({ status: "ok", files: [{ path: "a.ts" }] });
    expect(await readSources(b, "bad")).toEqual({ status: "invalid" });
    expect(await readSources(b, "gone")).toEqual({ status: "missing" });
  });
});
