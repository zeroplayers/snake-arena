import { describe, expect, it } from "vitest";
import { createTickLog, LOG_LIMIT_BYTES, utf8Length } from "./log";

describe("utf8Length", () => {
  it("counts UTF-8 bytes (lone surrogates encode as U+FFFD, 3 bytes)", () => {
    const cases: [string, number][] = [
      ["", 0],
      ["abc", 3],
      ["é", 2],
      ["€", 3],
      ["🐍", 4],
      ["a🐍b€é", 11],
      ["\ud800", 3],
      ["x\udc00y", 5],
    ];
    for (const [s, bytes] of cases) expect(utf8Length(s)).toBe(bytes);
  });
});

describe("createTickLog", () => {
  it("formats like console.log", () => {
    const t = createTickLog();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    t.log("mode", 3, { a: [1, 2] }, null, undefined, circular);
    expect(t.flush()).toEqual({
      lines: ['mode 3 {"a":[1,2]} null undefined [object Object]'],
      truncated: false,
    });
  });

  it("keeps lines up to the limit exactly", () => {
    const t = createTickLog(10);
    t.log("12345");
    t.log("67890");
    expect(t.flush()).toEqual({ lines: ["12345", "67890"], truncated: false });
  });

  it("cuts the overflowing line, marks it and drops later calls", () => {
    const t = createTickLog(10);
    t.log("abcd");
    t.log("efghijklmn");
    t.log("dropped");
    const out = t.flush();
    expect(out).toEqual({ lines: ["abcd", "efg…"], truncated: true });
    expect(out.lines.reduce((n, l) => n + utf8Length(l), 0)).toBeLessThanOrEqual(10);
  });

  it("never splits a multi-byte character", () => {
    const t = createTickLog(8);
    t.log("🐍🐍🐍");
    expect(t.flush().lines).toEqual(["🐍…"]);
  });

  it("drops the line when there is no room for the marker", () => {
    const t = createTickLog(5);
    t.log("abcd");
    t.log("efgh");
    expect(t.flush()).toEqual({ lines: ["abcd"], truncated: true });
  });

  it("resets the budget on flush", () => {
    const t = createTickLog();
    t.log("x".repeat(LOG_LIMIT_BYTES + 1));
    expect(t.flush().truncated).toBe(true);
    t.log("ok");
    expect(t.flush()).toEqual({ lines: ["ok"], truncated: false });
  });
});
