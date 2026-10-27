import { CliError, EXIT, UsageError } from "../errors.ts";
import { type Io, parse } from "../io.ts";
import {
  Api,
  ApiError,
  credentials,
  defaultRemote,
  explain,
  NetworkError,
  type Remote,
  withRetries,
} from "../remote/api.ts";
import { DEFAULT_URL, serverUrl } from "../remote/config.ts";
import { bold, cyan, dim, green, yellow } from "../term.ts";

/** `client_id` of the CLI in the site's device flow (`CLI_CLIENT_ID` in apps/web). */
export const CLIENT_ID = "zerosnake-cli";

const URL_OPTION = `  --url <url>    Server (default: ${DEFAULT_URL}, or ZEROSNAKE_URL)`;

export const LOGIN_HELP = `Usage: zerosnake login [options]

Signs the CLI in with your arena account: it shows a code, opens the site, and waits while you
approve it there (GitHub sign-in). The token is kept in your config folder, readable only by
you, and never printed. \`zerosnake logout\` revokes it.

Options:
${URL_OPTION}
  --no-open      Don't open a browser; just print the address
  -h, --help     Show this help`;

export const LOGOUT_HELP = `Usage: zerosnake logout [options]

Revokes the CLI's token on the server and deletes it from this computer.

Options:
${URL_OPTION}
  -h, --help     Show this help`;

const LOGIN_OPTIONS = {
  url: { type: "string" },
  open: { type: "boolean", default: true },
  help: { type: "boolean", short: "h" },
} as const;

const LOGOUT_OPTIONS = {
  url: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

/** `POST /api/auth/device/code` (RFC 8628 §3.2). */
interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  /** Seconds. */
  expires_in: number;
  /** Seconds between polls. */
  interval: number;
}

/** `POST /api/auth/cli/token` (RFC 8628 §3.5), on success. */
interface TokenResponse {
  access_token: string;
  token_type: string;
}

/** `GET /api/auth/cli/me`. */
interface CliIdentity {
  user: { username: string | null; name: string };
}

function noPositionals(positionals: string[], command: string): void {
  if (positionals.length > 0) {
    throw new UsageError(
      `Unexpected argument "${positionals[0]}". Run \`zerosnake ${command} --help\` for the options.`,
    );
  }
}

export async function loginCommand(
  argv: string[],
  io: Io,
  remote: Remote = defaultRemote(),
): Promise<number> {
  const { values, positionals } = parse(argv, LOGIN_OPTIONS, "login");
  if (values.help) {
    io.out(LOGIN_HELP);
    return EXIT.ok;
  }
  noPositionals(positionals, "login");
  const server = serverUrl(values.url, remote.env);
  const store = credentials(remote);
  const previous = store.get(server);
  const api = new Api(server, remote);

  let code: DeviceCode;
  try {
    code = await api.call<DeviceCode>("POST", "/api/auth/device/code", {
      body: { client_id: CLIENT_ID },
    });
  } catch (e) {
    throw explain(e, server);
  }
  const page = new URL(code.verification_uri, server).href;
  const direct = code.verification_uri_complete
    ? new URL(code.verification_uri_complete, server).href
    : page;

  io.out(`To sign in, open ${cyan(page)} and enter the code:\n\n    ${bold(code.user_code)}\n`);
  if (values.open) {
    io.out(dim("Opening your browser…"));
    remote.openBrowser(direct);
  }

  const token = await pollForToken(api, code, io, remote);
  const signedIn = new Api(server, remote, token);
  let me: CliIdentity;
  try {
    me = await withRetries(remote, () => signedIn.call<CliIdentity>("GET", "/api/auth/cli/me"), {
      maxWaitMs: 15_000,
    });
  } catch (e) {
    // Not saved, so revoke it: otherwise it stays valid (and listed in /settings) for 90 days.
    const revoked = await revoke(signedIn);
    throw new CliError(
      `${explain(e, server).message}\n` +
        (revoked
          ? "The new login wasn't saved."
          : `The new login wasn't saved, and couldn't be revoked: remove it at ${server}/settings.`),
    );
  }
  const username = me.user.username;
  store.set(server, { token, username, savedAt: new Date(remote.now()).toISOString() });

  // The token this one replaces would otherwise stay valid (and listed in /settings) for 90 days.
  if (previous && previous.token !== token) await revoke(new Api(server, remote, previous.token));
  io.out(
    `${green("✓")} Logged in to ${server} as ${bold(username ? `@${username}` : me.user.name)}.`,
  );
  if (remote.env.ZEROSNAKE_TOKEN) {
    io.err(yellow("Note: ZEROSNAKE_TOKEN is set, and the CLI uses it instead of this login."));
  }
  return EXIT.ok;
}

/** Revokes the `api`'s token; `false` if the server couldn't be asked. Already revoked counts. */
async function revoke(api: Api): Promise<boolean> {
  try {
    await api.call("POST", "/api/auth/cli/logout", { body: {} });
    return true;
  } catch (e) {
    // 401: already expired or revoked (e.g. on the settings page), so there's nothing to revoke.
    return e instanceof ApiError && e.status === 401;
  }
}

/** Polls the token endpoint until the person approves, denies, or the code expires. */
async function pollForToken(api: Api, code: DeviceCode, io: Io, remote: Remote): Promise<string> {
  let interval = Math.max(1, code.interval) * 1000;
  const deadline = remote.now() + code.expires_in * 1000;
  const waiting = `Waiting for you to approve ${bold(code.user_code)} in the browser… ${dim("(Ctrl+C to cancel)")}`;
  io.progress?.(waiting);
  try {
    while (remote.now() < deadline) {
      await remote.sleep(interval);
      try {
        const token = await api.call<TokenResponse>("POST", "/api/auth/cli/token", {
          body: {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: code.device_code,
            client_id: CLIENT_ID,
          },
        });
        if (typeof token.access_token !== "string") throw new ApiError(200, token, "/cli/token");
        return token.access_token;
      } catch (e) {
        if (e instanceof NetworkError || (e instanceof ApiError && e.status >= 500)) {
          io.progress?.(`${waiting} ${yellow("(connection trouble, retrying)")}`);
          continue;
        }
        if (!(e instanceof ApiError)) throw explain(e, api.server);
        switch (e.code) {
          case "authorization_pending":
            io.progress?.(waiting);
            continue;
          case "slow_down":
            interval += 5000;
            continue;
          case "access_denied":
            throw new CliError("The login was denied in the browser. Nothing was saved.");
          case "expired_token":
            throw expiredCode();
          default: {
            const description = (e.json as { error_description?: unknown } | null)
              ?.error_description;
            if (typeof description === "string") {
              throw new CliError(
                `The login failed: ${description}. Run \`zerosnake login\` again.`,
              );
            }
            throw explain(e, api.server);
          }
        }
      }
    }
    throw expiredCode();
  } finally {
    io.progress?.("");
  }
}

function expiredCode(): CliError {
  return new CliError("The code expired before it was approved. Run `zerosnake login` again.");
}

export async function logoutCommand(
  argv: string[],
  io: Io,
  remote: Remote = defaultRemote(),
): Promise<number> {
  const { values, positionals } = parse(argv, LOGOUT_OPTIONS, "logout");
  if (values.help) {
    io.out(LOGOUT_HELP);
    return EXIT.ok;
  }
  noPositionals(positionals, "logout");
  const server = serverUrl(values.url, remote.env);
  const store = credentials(remote);
  const saved = store.get(server);
  if (!saved) {
    io.out(`You aren't logged in to ${server}.`);
    return EXIT.ok;
  }

  const revoked = await revoke(new Api(server, remote, saved.token));
  store.delete(server);
  io.out(`${green("✓")} Logged out of ${server}.`);
  if (!revoked) {
    io.err(
      yellow(
        `Couldn't reach the server to revoke the token. It's deleted here; revoke it at ${server}/settings.`,
      ),
    );
  }
  return EXIT.ok;
}
