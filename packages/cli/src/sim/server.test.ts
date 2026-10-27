import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { MatchUpdate, SimLife } from "./protocol.ts";
import { type SimServer, startSimServer } from "./server.ts";

const info = { tps: 10, arenaHalfSize: 89, visionRadius: 40, title: "test" };
const life: SimLife = { id: "a#1", bot: "a", author: "a", bornTick: 0, you: true };
let server: SimServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function get(path: string): Promise<Response> {
  return fetch(new URL(path, server?.url));
}

describe("startSimServer", () => {
  it("serves the viewer page, its bundle and the match as it grows", async () => {
    server = await startSimServer({ info, bots: ["a"], port: 0 });

    const page = await (await get("/")).text();
    expect(page).toContain('<script type="module" src="/client.js">');
    const client = await get("/client.js");
    expect(client.headers.get("content-type")).toContain("javascript");
    expect((await client.text()).length).toBeGreaterThan(100_000); // viewer + three.js

    let update = (await (await get("/api/match?from=0")).json()) as MatchUpdate;
    expect(update).toMatchObject({ info, bots: ["a"], from: 0, chunks: [], done: false });

    server.publish({ bytes: new Uint8Array([1, 2, 3]), calls: [{ "a#1": { o: 1, a: 0 } }] }, [
      life,
    ]);
    server.publish({ bytes: new Uint8Array([4]), calls: [] }, [life]);
    server.finish([
      { ...life, death: { tick: 5, cause: "wall", killerId: null, score: 1, mass: 2, kills: 0 } },
    ]);

    update = (await (await get("/api/match?from=1")).json()) as MatchUpdate;
    expect(update.from).toBe(1);
    expect(update.chunks).toEqual([{ data: "BA==", calls: [] }]);
    expect(update.done).toBe(true);
    expect(update.lives[0]?.death?.cause).toBe("wall");
    expect((await get("/nope")).status).toBe(404);
  }, 20_000);

  it("answers only requests addressed to this machine (no DNS rebinding)", async () => {
    server = await startSimServer({ info, bots: [], port: 0 });
    const { port } = new URL(server.url);
    const status = (host: string) =>
      new Promise<number>((resolve, reject) => {
        request({ host: "127.0.0.1", port, path: "/api/match", headers: { host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
          .on("error", reject)
          .end();
      });
    expect(await status(`localhost:${port}`)).toBe(200);
    expect(await status(`127.0.0.1:${port}`)).toBe(200);
    expect(await status(`[::1]:${port}`)).toBe(200);
    expect(await status(`evil.example:${port}`)).toBe(403);
    expect(await status("localhost.evil.example")).toBe(403);
  }, 20_000);

  it("takes the next port when the first is busy", async () => {
    const first = await startSimServer({ info, bots: [], port: 0 });
    const port = Number(new URL(first.url).port);
    try {
      server = await startSimServer({ info, bots: [], port });
      expect(Number(new URL(server.url).port)).toBeGreaterThan(port);
    } finally {
      await first.close();
    }
  }, 20_000);
});
