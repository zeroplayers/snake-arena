import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { MatchInfo } from "@zerosnake/viewer";
import { type BuildOptions, build } from "esbuild";
import { BUNDLED, distFile } from "../assets.ts";
import { packageRoot } from "../paths.ts";
import type { MatchUpdate, SimChunk, SimLife } from "./protocol.ts";

export const DEFAULT_PORT = 5757;
/** Ports tried after the requested one when it is taken. */
const PORT_ATTEMPTS = 20;

export interface SimServerOptions {
  info: MatchInfo;
  /** Bot names in lineup order. */
  bots: string[];
  port?: number;
}

/** The local viewer server of `zerosnake sim`. Feed it chunks as the match produces them. */
export interface SimServer {
  readonly url: string;
  publish(chunk: SimChunk, lives: readonly SimLife[]): void;
  /** The match ended (or failed with `error`). */
  finish(lives: readonly SimLife[], error?: string): void;
  close(): Promise<void>;
}

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>zerosnake sim</title>
    <style>
      html, body { margin: 0; height: 100%; background: #07080a; color: #c9d1d9; }
      #app { position: fixed; inset: 0; }
      #status { position: fixed; inset: 0; display: grid; place-items: center;
        font: 14px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <div id="status">Waiting for the first ticks…</div>
    <script type="module" src="/client.js"></script>
  </body>
</html>
`;

/** esbuild options for the viewer page (viewer, renderer, three.js, engine), for the browser. */
export function clientBuildOptions(): BuildOptions {
  return {
    entryPoints: [join(packageRoot(), "src", "sim", "client.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    logLevel: "silent",
  };
}

let client: Promise<string> | undefined;

/** The viewer page's script: prebuilt in `dist/client.js`, or bundled from source once. */
export function bundleClient(): Promise<string> {
  client ??= BUNDLED
    ? Promise.resolve(distFile("client.js"))
    : build({ ...clientBuildOptions(), write: false }).then(
        (out) => out.outputFiles[0]?.text ?? "",
      );
  return client;
}

export async function startSimServer(options: SimServerOptions): Promise<SimServer> {
  const script = await bundleClient();
  const chunks: { data: string; calls: SimChunk["calls"] }[] = [];
  let lives: readonly SimLife[] = [];
  let done = false;
  let error: string | undefined;

  const server = createServer((req, res) => {
    // Only pages on this machine may read the match (bot logs): a DNS-rebinding page arrives
    // with its own host name.
    if (!isLocalHost(req.headers.host)) {
      res
        .writeHead(403, { "content-type": "text/plain" })
        .end("zerosnake sim only answers localhost");
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
    } else if (url.pathname === "/client.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(script);
    } else if (url.pathname === "/api/match") {
      const from = Math.max(0, Math.floor(Number(url.searchParams.get("from")) || 0));
      const update: MatchUpdate = {
        info: options.info,
        bots: options.bots,
        from,
        chunks: chunks.slice(from),
        lives: [...lives],
        done,
        ...(error !== undefined && { error }),
      };
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(update));
    } else {
      res.writeHead(404).end();
    }
  });

  const port = await listen(server, options.port ?? DEFAULT_PORT);
  return {
    url: `http://localhost:${port}/`,
    publish(chunk, current) {
      chunks.push({ data: Buffer.from(chunk.bytes).toString("base64"), calls: chunk.calls });
      lives = current.map((l) => ({ ...l }));
    },
    finish(current, message) {
      lives = current.map((l) => ({ ...l }));
      done = true;
      error = message;
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether a `Host` header names this machine (any port). */
export function isLocalHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return LOCAL_HOSTS.has(name);
}

async function listen(server: Server, first: number): Promise<number> {
  for (let port = first; ; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      return typeof address === "object" && address ? address.port : port;
    } catch (e) {
      const inUse = (e as NodeJS.ErrnoException).code === "EADDRINUSE";
      if (!inUse || port === 0 || port >= first + PORT_ATTEMPTS) throw e;
    }
  }
}

/** Opens `url` in the default browser; quietly does nothing where that isn't possible. */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No browser here (CI, SSH): the URL is printed anyway.
  }
}
