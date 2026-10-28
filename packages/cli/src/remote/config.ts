import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError, UsageError } from "../errors.ts";

/**
 * The public site (apps/web `SITE_URL`, a test checks). `--url` or `ZEROSNAKE_URL` point elsewhere.
 */
export const DEFAULT_URL = "https://zerosnake.dev";

export type Env = Record<string, string | undefined>;

/**
 * The server to talk to: `--url`, else `ZEROSNAKE_URL`, else {@link DEFAULT_URL}, as an origin
 * (`https://host[:port]`). Plain `http` only for this machine, so a token never crosses the
 * network in the clear.
 */
export function serverUrl(flag: string | undefined, env: Env): string {
  const raw = flag ?? env.ZEROSNAKE_URL ?? DEFAULT_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`"${raw}" isn't a URL. Use something like ${DEFAULT_URL}.`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new UsageError(`${raw}: the server must use https (http only for localhost).`);
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new UsageError(`${raw}: give only the server's address, like ${DEFAULT_URL}.`);
  }
  return url.origin;
}

/**
 * Where `login` keeps tokens: `ZEROSNAKE_CONFIG_DIR`, else the platform's config folder
 * (`~/Library/Application Support/zerosnake`, `%APPDATA%\zerosnake`, or
 * `$XDG_CONFIG_HOME/zerosnake` / `~/.config/zerosnake`).
 */
export function configDir(env: Env, platform = process.platform, home = homedir()): string {
  if (env.ZEROSNAKE_CONFIG_DIR) return env.ZEROSNAKE_CONFIG_DIR;
  if (platform === "win32") {
    return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "zerosnake");
  }
  if (platform === "darwin") return join(home, "Library", "Application Support", "zerosnake");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "zerosnake");
}

export interface Credential {
  /** `zsk_…`. Never printed or logged. */
  token: string;
  username: string | null;
  /** ISO 8601. */
  savedAt: string;
}

interface CredentialsFile {
  version: 1;
  /** By server origin, so a local server's token never goes to staging and vice versa. */
  servers: Record<string, Credential>;
}

const FILE = "credentials.json";

/** The token store: one JSON file, readable by its owner only (0600, in a 0700 folder). */
export class Credentials {
  readonly file: string;

  constructor(readonly dir: string) {
    this.file = join(dir, FILE);
  }

  get(server: string): Credential | null {
    return this.read().servers[server] ?? null;
  }

  set(server: string, credential: Credential): void {
    const data = this.read();
    data.servers[server] = credential;
    this.write(data);
  }

  /** `true` if there was a token for `server`. */
  delete(server: string): boolean {
    const data = this.read();
    if (!data.servers[server]) return false;
    delete data.servers[server];
    if (Object.keys(data.servers).length === 0) rmSync(this.file, { force: true });
    else this.write(data);
    return true;
  }

  private read(): CredentialsFile {
    if (!existsSync(this.file)) return { version: 1, servers: {} };
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as CredentialsFile;
      if (data.version === 1 && typeof data.servers === "object" && data.servers) return data;
    } catch {
      // Fall through.
    }
    throw new CliError(`${this.file} is damaged. Delete it and run \`zerosnake login\` again.`);
  }

  private write(data: CredentialsFile): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // Written aside and renamed, so a crash never leaves half a file; created 0600, so the token
    // is never readable by others, not even for a moment.
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
}
